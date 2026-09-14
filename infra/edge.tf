# edge.tf — internal ALB, VPC Link, API Gateway HTTP API.
#
# DRI: Meron (Platform + delivery).
#
#   internet -> API Gateway (HTTP API) -> VPC Link -> internal ALB -> ECS tasks
#
# The ALB is internal and its security group accepts traffic only from the VPC
# Link SG, so there is no way to reach a task except through API Gateway. That is
# the "direct-to-ALB bypass" mitigation in docs/threat-model.md (line 47).

# ---------------------------------------------------------------------------
# ALB
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${local.prefix}-alb"
  description = "Internal ALB: accepts traffic from the VPC Link only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name    = "${local.prefix}-alb"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_vpclink" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.vpclink.id
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
  description                  = "HTTP from the API Gateway VPC Link (internal hop)"

  tags = {
    Name    = "${local.prefix}-alb-from-vpclink"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id = aws_security_group.alb.id
  from_port         = var.app_port
  to_port           = var.app_port
  ip_protocol       = "tcp"
  cidr_ipv4         = aws_vpc.main.cidr_block
  description       = "Forward to ECS tasks in the VPC"

  tags = {
    Name    = "${local.prefix}-alb-to-tasks"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_lb" "main" {
  name               = "${local.prefix}-alb"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for s in aws_subnet.private : s.id]

  drop_invalid_header_fields = true
  enable_deletion_protection = false # capstone: destroy/rebuild must work

  access_logs {
    # Resource reference, not local.buckets.logs by name: this makes Terraform
    # create the bucket + its log-delivery policy (storage.tf) before the ALB,
    # so enabling access logs can never race an as-yet-nonexistent bucket.
    bucket  = aws_s3_bucket.logs.id
    prefix  = "alb"
    enabled = var.enable_alb_access_logs
  }

  depends_on = [aws_s3_bucket_policy.logs]

  tags = {
    Name    = "${local.prefix}-alb"
    service = "platform"
    owner   = "meron"
  }
}

# One target group per HTTP service (commission is a worker: no inbound traffic).
resource "aws_lb_target_group" "service" {
  for_each = toset([for s in local.services : s if s != "commission"])

  name        = "${local.prefix}-${each.key}"
  port        = var.app_port
  protocol    = "HTTP"
  target_type = "ip" # awsvpc mode gives each task its own ENI
  vpc_id      = aws_vpc.main.id

  # /ready, not /health: the ALB should stop sending traffic to a task that is
  # alive but not able to serve (draining, dependency down). /health is for ECS.
  health_check {
    enabled             = true
    path                = "/ready"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Match the app's drain window so in-flight requests finish.
  deregistration_delay = 30

  tags = {
    Name    = "${local.prefix}-${each.key}"
    service = each.key
    owner   = local.service_owner[each.key]
  }

  lifecycle {
    create_before_destroy = true
  }
}

# HTTP, not HTTPS, on the internal hop.
#
# API Gateway validates the certificate chain of a private integration target,
# and a self-signed cert has no chain to validate -- every request failed in
# ~10ms with a bare 500 and an empty integrationError. A public CA cert would
# need a real domain and DNS validation for a listener that is unreachable from
# outside the VPC. Public TLS terminates at API Gateway; this hop is protected
# by the SG pairing instead (ALB accepts the VPC Link SG only, and the ALB has
# no public IP), which is the control docs/threat-model.md line 47 actually
# names. Revisit if the capstone acquires a domain.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # Unrouted paths are rejected at the edge rather than reaching a service.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({ error = "no_route" })
      status_code  = "404"
    }
  }

  tags = {
    Name    = "${local.prefix}-https"
    service = "platform"
    owner   = "meron"
  }
}

# Path routing. `web` is the default; the APIs live under their own prefixes.
resource "aws_lb_listener_rule" "service" {
  for_each = {
    pos      = { priority = 10, paths = ["/api/pos/*", "/pos/*"] }
    payments = { priority = 20, paths = ["/api/payments/*", "/payments/*"] }
  }

  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service[each.key].arn
  }

  condition {
    path_pattern {
      values = each.value.paths
    }
  }

  tags = {
    Name    = "${local.prefix}-${each.key}"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# Everything else goes to web.
resource "aws_lb_listener_rule" "web_default" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["web"].arn
  }

  condition {
    path_pattern {
      values = ["/*"]
    }
  }

  tags = {
    Name    = "${local.prefix}-web"
    service = "web"
    owner   = local.service_owner["web"]
  }
}

# ---------------------------------------------------------------------------
# VPC Link + API Gateway
# ---------------------------------------------------------------------------

resource "aws_security_group" "vpclink" {
  name        = "${local.prefix}-vpclink"
  description = "API Gateway VPC Link ENIs"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name    = "${local.prefix}-vpclink"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_vpc_security_group_egress_rule" "vpclink_to_alb" {
  security_group_id            = aws_security_group.vpclink.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
  description                  = "To the internal ALB (internal hop)"

  tags = {
    Name    = "${local.prefix}-vpclink-to-alb"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_apigatewayv2_vpc_link" "main" {
  name               = local.prefix
  security_group_ids = [aws_security_group.vpclink.id]
  subnet_ids         = [for s in aws_subnet.private : s.id]

  tags = {
    Name    = local.prefix
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_apigatewayv2_api" "main" {
  name          = local.prefix
  protocol_type = "HTTP"
  description   = "TillFlow public edge — the only ingress into the VPC"

  tags = {
    Name    = local.prefix
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_apigatewayv2_integration" "alb" {
  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_uri    = aws_lb_listener.https.arn
  integration_method = "ANY"

  connection_type = "VPC_LINK"
  connection_id   = aws_apigatewayv2_vpc_link.main.id

  # HTTP_PROXY integrations only support payload format 1.0 (AWS rejects 2.0
  # outright), unlike the AWS_PROXY/Lambda case where 2.0 is the default.
  payload_format_version = "1.0"
  timeout_milliseconds   = 29000

  # No tls_config.
  #
  # `server_name_to_verify` does the opposite of what the name suggests here: it
  # makes API Gateway VALIDATE the ALB's certificate against that hostname. The
  # ALB presents a self-signed cert (see above), so validation fails and every
  # request returns 500 with no access-log entry. Omitting the block leaves the
  # hop encrypted but unvalidated -- acceptable because it never leaves the VPC
  # and the ALB's SG accepts the VPC Link SG only.
}

resource "aws_apigatewayv2_route" "proxy" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.alb.id}"
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/${local.prefix}/apigw"
  retention_in_days = 14

  tags = {
    Name    = "/${local.prefix}/apigw"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
    # requestId ties an edge log line to the trace the sidecar exports.
    format = jsonencode({
      requestId        = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      protocol         = "$context.protocol"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
      latency          = "$context.responseLatency"
    })
  }

  default_route_settings {
    # Blunt protection against an STK-push flood running up Daraja cost --
    # docs/threat-model.md line 40. Per-tenant limits come with G2.
    throttling_burst_limit   = var.api_throttle_burst
    throttling_rate_limit    = var.api_throttle_rate
    detailed_metrics_enabled = true
  }

  # The stage's own name must be the literal `$default`; the prefix lives in the
  # Name tag, which is what the audit checks for id-addressed resources.
  tags = {
    Name    = "${local.prefix}-apigw-default"
    service = "platform"
    owner   = "meron"
  }
}
