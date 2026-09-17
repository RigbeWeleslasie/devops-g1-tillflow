# service-mesh.tf — private service discovery and per-service configuration.
#
# DRI: Meron (Platform + delivery).
#
# Answers §2 and §3 of evidence/payments-integrity/deployment-contract.md: how a
# task finds another task, and what each service is handed at boot.

# ---------------------------------------------------------------------------
# Service discovery
#
# POS calls Payments; Commission calls both. Two ways to route that:
#
#   through the internal ALB -- an internal call would leave the task, traverse
#     the load balancer, and come back, paying a hop and an ALB rule for traffic
#     that never leaves the VPC, and putting every internal call behind the same
#     listener the public edge uses.
#
#   service discovery -- Cloud Map gives each service a private DNS name; tasks
#     talk to each other directly. The `*_BASE_URL` values in the contract
#     already assume this shape.
#
# Service discovery, then. The internal ALB stays exactly what it is: the path
# in from API Gateway.
# ---------------------------------------------------------------------------

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "${local.prefix}.internal"
  description = "Private DNS for TillFlow service-to-service calls"
  vpc         = aws_vpc.main.id

  tags = {
    Name    = "${local.prefix}.internal"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_service_discovery_service" "service" {
  for_each = toset(local.services)

  name = "${local.prefix}-${each.key}"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id

    dns_records {
      # A records, not SRV: awsvpc gives every task its own IP, so the name
      # resolves straight to the set of healthy task IPs and the client needs no
      # port discovery -- the port is fixed at var.app_port.
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  # ECS deregisters an instance when its task stops; this catches the case where
  # a task dies without ECS noticing in time.
  health_check_custom_config {
    failure_threshold = 1
  }

  tags = {
    Name    = "${local.prefix}-${each.key}"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# Tasks must be able to reach each other on the app port. The ALB ingress rule
# in ecs.tf only admits the ALB, so without this every internal call times out.
#
# Scoped to the VPC CIDR rather than per-service pairs: the pairs that matter
# (pos->payments, commission->both) are already enforced above this layer by the
# service token, and a rule per direction would be six rules to maintain for a
# boundary the token already holds. The SG still excludes everything outside
# the VPC.
resource "aws_vpc_security_group_ingress_rule" "service_from_service" {
  for_each = toset(local.services)

  security_group_id = aws_security_group.service[each.key].id
  from_port         = var.app_port
  to_port           = var.app_port
  ip_protocol       = "tcp"
  cidr_ipv4         = aws_vpc.main.cidr_block
  description       = "Service-to-service calls from within the VPC"

  tags = {
    Name    = "${local.prefix}-${each.key}-from-vpc"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

resource "aws_vpc_security_group_egress_rule" "service_to_service" {
  for_each = toset(local.services)

  security_group_id = aws_security_group.service[each.key].id
  from_port         = var.app_port
  to_port           = var.app_port
  ip_protocol       = "tcp"
  cidr_ipv4         = aws_vpc.main.cidr_block
  description       = "Calls to sibling services within the VPC"

  tags = {
    Name    = "${local.prefix}-${each.key}-to-vpc"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# ---------------------------------------------------------------------------
# Per-service configuration (contract §2)
#
# `environment` carries anything safe to read from a task definition;
# `secrets` carries everything else, resolved from Secrets Manager at container
# start so no value ever lands in the task definition, a plan, or
# `describe-task-definition` output.
# ---------------------------------------------------------------------------

locals {
  # http://devops-g1-pos.devops-g1.internal:8080
  service_url = {
    for s in local.services :
    s => "http://${local.prefix}-${s}.${aws_service_discovery_private_dns_namespace.main.name}:${var.app_port}"
  }

  # Daraja posts callbacks from the public internet, so this is the API Gateway
  # endpoint -- not an internal name.
  mpesa_callback_base_url = "${aws_apigatewayv2_api.main.api_endpoint}/payments"

  service_env = {
    web = []

    pos = [
      { name = "PAYMENTS_BASE_URL", value = local.service_url["payments"] },
    ]

    payments = [
      { name = "MPESA_CALLBACK_BASE_URL", value = local.mpesa_callback_base_url },
      # `daraja`, never `fake`, when ENVIRONMENT=prod -- the service refuses to
      # start on the fake adapter in prod, which is the guard that keeps a
      # deterministic stub out of a real deployment.
      { name = "MPESA_ADAPTER", value = var.mpesa_adapter },
      { name = "SALE_EVENTS_QUEUE_URL", value = aws_sqs_queue.main["sale-events"].url },
      { name = "AWS_REGION", value = var.aws_region },
    ]

    commission = [
      { name = "POS_BASE_URL", value = local.service_url["pos"] },
      { name = "PAYMENTS_BASE_URL", value = local.service_url["payments"] },
      { name = "CLOSE_QUEUE_URL", value = aws_sqs_queue.main["commission-payout"].url },
      { name = "AWS_REGION", value = var.aws_region },
    ]
  }

  # `:<json-key>::` selects one field out of a JSON secret. Without it the
  # container receives the whole `{"token":"..."}` blob as its value -- which is
  # worse than a crash, because the service starts cleanly and every internal
  # call 401s.
  service_token_ref = "${aws_secretsmanager_secret.service_token.arn}:token::"

  # DATABASE_URL is assembled by the migration job and stored whole, so the
  # service reads one value rather than composing a URL from five.
  db_url_ref = {
    for s in local.services :
    s => "${aws_secretsmanager_secret.service_db_password[s].arn}:database_url::"
  }

  daraja_arn = aws_secretsmanager_secret.daraja.arn

  service_secrets = {
    # The web shell authenticates browsers with a JWT; it makes no
    # service-to-service call and gets no service token.
    web = []

    pos = [
      { name = "SERVICE_TOKEN", valueFrom = local.service_token_ref },
      { name = "DATABASE_URL", valueFrom = local.db_url_ref["pos"] },
      { name = "JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.jwt.arn}:secret::" },
    ]

    payments = [
      { name = "SERVICE_TOKEN", valueFrom = local.service_token_ref },
      { name = "DATABASE_URL", valueFrom = local.db_url_ref["payments"] },
      { name = "DARAJA_CONSUMER_KEY", valueFrom = "${local.daraja_arn}:consumer_key::" },
      { name = "DARAJA_CONSUMER_SECRET", valueFrom = "${local.daraja_arn}:consumer_secret::" },
      { name = "DARAJA_SHORTCODE", valueFrom = "${local.daraja_arn}:shortcode::" },
      { name = "DARAJA_PASSKEY", valueFrom = "${local.daraja_arn}:passkey::" },
      { name = "DARAJA_BASE_URL", valueFrom = "${local.daraja_arn}:base_url::" },
      { name = "DARAJA_B2C_INITIATOR", valueFrom = "${local.daraja_arn}:initiator_name::" },
      { name = "DARAJA_B2C_SECURITY_CREDENTIAL", valueFrom = "${local.daraja_arn}:security_credential::" },
      { name = "DARAJA_B2C_SHORTCODE", valueFrom = "${local.daraja_arn}:b2c_shortcode::" },
    ]

    commission = [
      { name = "SERVICE_TOKEN", valueFrom = local.service_token_ref },
      # Shares the payments schema and role (ADR 0003), so it reads the same
      # credential rather than one of its own.
      { name = "DATABASE_URL", valueFrom = local.db_url_ref["payments"] },
    ]
  }
}
