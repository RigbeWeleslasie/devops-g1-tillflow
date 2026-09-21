# observability.tf — alarms, dashboards, synthetic probe.
#
# DRI: Meron (Platform + delivery) owns the Terraform. The SLI/SLO definitions,
# burn-rate policy and alert contract this implements are Rigbe's
# (docs/slo-error-budgets.md, docs/runbook.md, Area 4 in docs/ownership.md).
# Where a threshold here encodes a number, that number comes from those docs
# rather than from this file's own judgement.
#
# G3 blockers this addresses:
#   - "no external probe"   -> aws_lambda_function.uptime (outside the VPC)
#   - "no actionable alert" -> alarm -> SNS -> Slack (firing AND recovery)
#   - "no per-service budget" -> multi-window burn-rate alarms bound to the SLI
#     counters (bottom of this file), plus per-service ALB/ECS/SQS/RDS alarms
#     covering the failure modes the SLIs do not.

# ---------------------------------------------------------------------------
# External uptime probe
#
# A Lambda with NO vpc_config, so it egresses to the public internet and hits
# API Gateway the way an attendant's browser does. ECS and ALB health checks
# cannot see an API Gateway 5xx, a dead VPC Link, or a bad route.
#
# This is not CloudWatch Synthetics. That resource was tried first: this
# account's Synthetics Lambdas reject MemorySize > 512, and the AWS provider
# (>= 5.60) rejects MemorySize < 960, so the canary cannot be created through
# Terraform. A scheduled Lambda publishing the same SuccessPercent metric is
# the same external signal and actually applies.
# ---------------------------------------------------------------------------

data "archive_file" "uptime" {
  type        = "zip"
  output_path = "${path.module}/.terraform/tmp/uptime-probe.zip"

  source {
    content  = file("${path.module}/alerting/probe.py")
    filename = "probe.py"
  }
}

data "aws_iam_policy_document" "canary_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "canary" {
  name               = "${local.prefix}-canary"
  description        = "External uptime probe (Lambda, outside the VPC)"
  assume_role_policy = data.aws_iam_policy_document.canary_assume.json

  tags = {
    Name    = "${local.prefix}-canary"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_cloudwatch_log_group" "uptime" {
  name              = "/aws/lambda/${local.prefix}-uptime"
  retention_in_days = 14

  tags = {
    Name    = "/aws/lambda/${local.prefix}-uptime"
    service = "platform"
    owner   = "meron"
  }
}

data "aws_iam_policy_document" "canary" {
  statement {
    sid     = "Logs"
    effect  = "Allow"
    actions = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      aws_cloudwatch_log_group.uptime.arn,
      "${aws_cloudwatch_log_group.uptime.arn}:*",
    ]
  }

  statement {
    sid       = "PublishCanaryMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CloudWatchSynthetics"]
    }
  }
}

resource "aws_iam_role_policy" "canary" {
  name   = "${local.prefix}-canary"
  role   = aws_iam_role.canary.id
  policy = data.aws_iam_policy_document.canary.json
}

resource "aws_lambda_function" "uptime" {
  function_name    = "${local.prefix}-uptime"
  filename         = data.archive_file.uptime.output_path
  source_code_hash = data.archive_file.uptime.output_base64sha256
  role             = aws_iam_role.canary.arn
  handler          = "probe.handler"
  runtime          = "python3.12"
  timeout          = 45
  memory_size      = 256

  environment {
    variables = {
      TARGET_BASE_URL = aws_apigatewayv2_api.main.api_endpoint
      TARGET_SERVICES = join(",", var.canary_target_services)
      CANARY_NAME     = "${local.prefix}-uptime"
    }
  }

  depends_on = [aws_iam_role_policy.canary, aws_cloudwatch_log_group.uptime]

  tags = {
    Name    = "${local.prefix}-uptime"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_cloudwatch_event_rule" "uptime" {
  name                = "${local.prefix}-uptime"
  description         = "Fire the external uptime probe"
  schedule_expression = var.canary_schedule_expression

  tags = {
    Name    = "${local.prefix}-uptime"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_cloudwatch_event_target" "uptime" {
  rule      = aws_cloudwatch_event_rule.uptime.name
  target_id = "uptime"
  arn       = aws_lambda_function.uptime.arn
}

resource "aws_lambda_permission" "uptime_events" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.uptime.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.uptime.arn
}

# ---------------------------------------------------------------------------
# Probe alarm
#
# Actionability, per the runbook's alert contract: this fires on a sustained
# failure, not a single blip. 1-minute period x 3 datapoints out of 5 means a
# lone timeout or one ECS task recycling does not page anyone, while a genuine
# edge outage alerts within ~3 minutes.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "canary_failed" {
  alarm_name          = "${local.prefix}-uptime-probe-failing"
  comparison_operator = "LessThanThreshold"
  threshold           = 100
  evaluation_periods  = 5
  datapoints_to_alarm = 3

  metric_name = "SuccessPercent"
  namespace   = "CloudWatchSynthetics"
  period      = 60
  statistic   = "Average"

  dimensions = {
    CanaryName = aws_lambda_function.uptime.function_name
  }

  # A canary that stops reporting is an outage signal, not an absence of one:
  # treating missing data as breaching is what makes "the probe itself died"
  # visible instead of silently green.
  treat_missing_data = "breaching"

  alarm_description = jsonencode({
    environment = var.environment
    service     = "edge"
    symptom     = "External uptime probe is failing through the public API Gateway edge."
    impact      = "Users cannot reach the app. Burns the web availability budget (target 99.9%, docs/slo-error-budgets.md)."
    observed    = "Synthetics SuccessPercent < 100 on 3 of the last 5 one-minute runs."
    runbook     = "docs/runbook.md#23-platform-failure--cache-or-worker-down"
    owner       = "meron"
    first_action = join(" ", [
      "Read /aws/lambda/devops-g1-uptime -- the exception names the service.",
      "If ALB targets are healthy the fault is at the edge (API Gateway route",
      "or VPC Link), not in the service."
    ])
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = {
    Name    = "${local.prefix}-uptime-probe-failing"
    service = "platform"
    owner   = "meron"
  }
}

# ---------------------------------------------------------------------------
# Alerting path: CloudWatch -> SNS -> Lambda -> Slack webhook
#
# The 9-field contract lives in each alarm's description (Rigbe's wording).
# The Lambda only renders it. Firing and OK both publish so G3's
# "Slack firing/recovery" evidence is one topic, not two mechanisms.
# ---------------------------------------------------------------------------

# Alert payloads carry the runbook's 9-field contract: service names, observed
# values and the first safe action. That is operational detail about how this
# system fails, so the topic is encrypted at rest rather than left on SNS's
# default (Trivy AWS-0095).
#
# Its own CMK, not the Secrets Manager key: alarm notifications are not
# secrets, and a shared key would mean anything able to decrypt an alert could
# also decrypt database credentials. Separate keys keep those grants distinct.
resource "aws_kms_key" "alerts" {
  description             = "${local.prefix} SNS alert topic encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.alerts_kms.json

  tags = {
    Name    = "${local.prefix}-alerts"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_kms_alias" "alerts" {
  name          = "alias/${local.prefix}-alerts"
  target_key_id = aws_kms_key.alerts.key_id
}

data "aws_iam_policy_document" "alerts_kms" {
  # Without this the account has no path to administer the key and it becomes
  # unmanageable -- including un-deletable at G5 cleanup.
  statement {
    sid       = "AccountAdmin"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  # CloudWatch publishes to the topic as a service principal, so it needs the
  # key directly. Omitting this does not fail the apply -- it silently breaks
  # every alarm notification at the moment one fires, which is the worst
  # possible time to discover it.
  statement {
    sid       = "CloudWatchPublish"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic" "alerts" {
  name              = "${local.prefix}-alerts"
  kms_master_key_id = aws_kms_key.alerts.arn

  tags = {
    Name    = "${local.prefix}-alerts"
    service = "platform"
    owner   = "meron"
  }
}

data "archive_file" "slack" {
  type        = "zip"
  output_path = "${path.module}/.terraform/tmp/slack-renderer.zip"

  source {
    content  = file("${path.module}/alerting/slack.py")
    filename = "slack.py"
  }
}

data "aws_iam_policy_document" "slack_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "slack" {
  name               = "${local.prefix}-slack-alerts"
  description        = "Renders CloudWatch alarms onto the Slack webhook"
  assume_role_policy = data.aws_iam_policy_document.slack_assume.json

  tags = {
    Name    = "${local.prefix}-slack-alerts"
    service = "platform"
    owner   = "meron"
  }
}

data "aws_iam_policy_document" "slack" {
  statement {
    sid       = "ReadWebhook"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.slack_webhook.arn]
  }

  statement {
    sid       = "DecryptWebhook"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]
  }

  statement {
    sid     = "Logs"
    effect  = "Allow"
    actions = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      aws_cloudwatch_log_group.slack.arn,
      "${aws_cloudwatch_log_group.slack.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "slack" {
  name   = "${local.prefix}-slack-alerts"
  role   = aws_iam_role.slack.id
  policy = data.aws_iam_policy_document.slack.json
}

resource "aws_cloudwatch_log_group" "slack" {
  name              = "/aws/lambda/${local.prefix}-slack-alerts"
  retention_in_days = 14

  tags = {
    Name    = "/aws/lambda/${local.prefix}-slack-alerts"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_lambda_function" "slack" {
  function_name    = "${local.prefix}-slack-alerts"
  filename         = data.archive_file.slack.output_path
  source_code_hash = data.archive_file.slack.output_base64sha256
  role             = aws_iam_role.slack.arn
  handler          = "slack.handler"
  runtime          = "python3.12"
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      SLACK_WEBHOOK_SECRET_ARN = aws_secretsmanager_secret.slack_webhook.arn

      # The workspace is in this same state, so the alert's "Grafana panel
      # link" field is wired from the resource rather than from a variable
      # somebody has to paste a URL into. var.grafana_url stays as an override
      # for a workspace managed outside this stack.
      GRAFANA_URL = var.grafana_url != "" ? var.grafana_url : "https://${aws_grafana_workspace.main.endpoint}"
    }
  }

  depends_on = [aws_iam_role_policy.slack, aws_cloudwatch_log_group.slack]

  tags = {
    Name    = "${local.prefix}-slack-alerts"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_lambda_permission" "slack_from_sns" {
  statement_id  = "AllowSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_subscription" "slack" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.slack.arn

  depends_on = [aws_lambda_permission.slack_from_sns]
}

locals {
  alert_topic = [aws_sns_topic.alerts.arn]

  # HTTP services with an ALB target group. commission is a worker (edge.tf).
  http_services = [for s in local.services : s if s != "commission"]
}

# ---------------------------------------------------------------------------
# Per-service ALB alarms
#
# These are the per-service budget proxy until app SLI counters exist. Missing
# datapoints are NOT breaching: web and payments sit at desiredCount 0 today,
# and a permanently red alarm is the G3 failure mode we are avoiding.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "tg_5xx" {
  for_each = toset(local.http_services)

  alarm_name          = "${local.prefix}-${each.key}-target-5xx"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 5
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Sum"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.service[each.key].arn_suffix
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = each.key
    symptom      = "ALB is seeing 5xx from ${each.key} tasks."
    impact       = "Eligible ${each.key} requests are failing. Burns that service's 28-day error budget."
    observed     = "HTTPCode_Target_5XX_Count >= 5 on 3 of the last 5 minutes."
    runbook      = "docs/runbook.md#24-broken-release--rollback"
    owner        = local.service_owner[each.key]
    first_action = "Check /version vs the last-good digest. If this started at a deploy, roll the ECS service back to the previous task definition. If not, check RDS and the target-group health."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-${each.key}-target-5xx"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

resource "aws_cloudwatch_metric_alarm" "tg_unhealthy" {
  for_each = toset(local.http_services)

  alarm_name          = "${local.prefix}-${each.key}-unhealthy-hosts"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Maximum"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.service[each.key].arn_suffix
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = each.key
    symptom      = "${each.key} has at least one unhealthy ALB target."
    impact       = "The remaining tasks are taking all traffic; a second failure takes this service down."
    observed     = "UnHealthyHostCount >= 1 for 3 of the last 5 minutes."
    runbook      = "docs/runbook.md#23-platform-failure--cache-or-worker-down"
    owner        = local.service_owner[each.key]
    first_action = "Open the ${each.key} target group. If /ready is 503 the dependency check is failing (RDS/Redis). If the task is cycling, read the ECS stopped-task reason."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-${each.key}-unhealthy-hosts"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

resource "aws_cloudwatch_metric_alarm" "tg_p95" {
  for_each = toset(local.http_services)

  alarm_name          = "${local.prefix}-${each.key}-p95-latency"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.5
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  extended_statistic  = "p95"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.service[each.key].arn_suffix
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = each.key
    symptom      = "${each.key} p95 latency is over the 500 ms SLO gate."
    impact       = "The latency half of the ${each.key} SLI is missing even when responses are 2xx."
    observed     = "TargetResponseTime p95 > 0.5s on 3 of the last 5 minutes."
    runbook      = "docs/runbook.md#23-platform-failure--cache-or-worker-down"
    owner        = local.service_owner[each.key]
    first_action = "Check ECS CPU/memory and RDS DatabaseConnections. If this is a deploy, compare p95 against the previous task definition."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-${each.key}-p95-latency"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# ---------------------------------------------------------------------------
# ECS saturation (k6 thresholds: CPU < 70%, memory < 75%)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = toset(local.services)

  alarm_name          = "${local.prefix}-${each.key}-cpu"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 70
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.service[each.key].name
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = each.key
    symptom      = "${each.key} CPU is at or above the 70% k6 saturation gate."
    impact       = "Latency will follow. Headroom for a traffic spike is gone."
    observed     = "CPUUtilization >= 70 on 3 of the last 5 minutes."
    runbook      = "docs/runbook.md#23-platform-failure--cache-or-worker-down"
    owner        = local.service_owner[each.key]
    first_action = "Confirm it is real load, not a crash-loop. If load, raise desiredCount by 1 and watch p95. Do not raise it blindly on commission -- check the close-queue age first."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-${each.key}-cpu"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  for_each = toset(local.services)

  alarm_name          = "${local.prefix}-${each.key}-memory"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 75
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.service[each.key].name
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = each.key
    symptom      = "${each.key} memory is at or above the 75% k6 saturation gate."
    impact       = "OOM kills drop in-flight requests and burn the availability budget."
    observed     = "MemoryUtilization >= 75 on 3 of the last 5 minutes."
    runbook      = "docs/runbook.md#23-platform-failure--cache-or-worker-down"
    owner        = local.service_owner[each.key]
    first_action = "Check for a leak (memory still climbing after traffic fell). If leak, roll back. If a one-off spike, raise task memory in the next release, not live."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-${each.key}-memory"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# ---------------------------------------------------------------------------
# SQS — stack-wide queues, attributed to the owning service in the contract
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each = local.queues

  alarm_name          = "${local.prefix}-${each.key}-age"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 120
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Maximum"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.main[each.key].name
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = each.value.service
    symptom      = "The ${each.key} queue is not draining."
    impact       = each.key == "commission-payout" ? "Payouts will miss the 06:30 EAT SLO." : "sale.paid events are delayed; POS will not mark sales paid."
    observed     = "ApproximateAgeOfOldestMessage > 120s on 3 of the last 5 minutes."
    runbook      = "docs/runbook.md#23-platform-failure--cache-or-worker-down"
    owner        = each.value.owner
    first_action = "Check the consumer service is running and not erroring. Do not purge the queue."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-${each.key}-age"
    service = each.value.service
    owner   = each.value.owner
  }
}

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  for_each = local.queues

  alarm_name          = "${local.prefix}-${each.key}-dlq"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  period              = 60
  statistic           = "Maximum"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dlq[each.key].name
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = each.value.service
    symptom      = "A message landed on the ${each.key} DLQ."
    impact       = "A user journey stopped after 5 retries. This is a G4 drill signal in production."
    observed     = "DLQ ApproximateNumberOfMessagesVisible >= 1."
    runbook      = "docs/runbook.md#23-platform-failure--cache-or-worker-down"
    owner        = each.value.owner
    first_action = "Inspect the DLQ body. Fix the cause. Redrive to the main queue. Never delete a money-related message."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-${each.key}-dlq"
    service = each.value.service
    owner   = each.value.owner
  }
}

# ---------------------------------------------------------------------------
# RDS
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.prefix}-rds-cpu"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 80
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Average"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  treat_missing_data  = "breaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = "platform"
    symptom      = "RDS CPU is at or above 80%."
    impact       = "Every service's latency SLI burns at once. POS writes and payments callbacks share this instance."
    observed     = "CPUUtilization >= 80 on 3 of the last 5 minutes."
    runbook      = "docs/runbook.md#23-platform-failure--cache-or-worker-down"
    owner        = "meron"
    first_action = "Open Performance Insights. If a query dominates, do not kill it on the money path -- scale connections down at the app first. A class change is a release, not a live fix."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-rds-cpu"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${local.prefix}-rds-storage"
  comparison_operator = "LessThanThreshold"
  threshold           = 2147483648
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  period              = 60
  statistic           = "Average"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  treat_missing_data  = "breaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = "platform"
    symptom      = "RDS has less than 2 GiB free."
    impact       = "Writes will start failing. POS sale inserts and the payout ledger both stop."
    observed     = "FreeStorageSpace < 2 GiB."
    runbook      = "docs/runbook.md#23-platform-failure--cache-or-worker-down"
    owner        = "meron"
    first_action = "Confirm storage autoscaling (max 100 GiB) is actually growing. If it is already at max, this is an incident -- do not DROP tables to make space."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-rds-storage"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_cloudwatch_metric_alarm" "apigw_5xx" {
  alarm_name          = "${local.prefix}-apigw-5xx"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 5
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  period              = 60
  statistic           = "Sum"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiId = aws_apigatewayv2_api.main.id
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = "edge"
    symptom      = "API Gateway is returning 5xx (edge, not the tasks)."
    impact       = "The canary will also fail. Users cannot reach any service."
    observed     = "AWS/ApiGateway 5xx >= 5 on 3 of the last 5 minutes."
    runbook      = "docs/runbook.md#23-platform-failure--cache-or-worker-down"
    owner        = "meron"
    first_action = "If ALB targets are healthy this is the VPC Link or a bad route. Do not restart ECS until the edge log group /${local.prefix}/apigw shows integrationError."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-apigw-5xx"
    service = "platform"
    owner   = "meron"
  }
}

# ---------------------------------------------------------------------------
# Amazon Managed Grafana
#
# Scope note (docs/ownership.md): the WORKSPACE and its data sources are
# Platform (Meron). The DASHBOARDS built inside it are Reliability (Rigbe) --
# Area 4 names the Grafana export as her personal proof, so nothing here
# creates a dashboard. This hands her a working, empty Grafana pointed at the
# right data.
#
# `data_sources` grants the workspace role read access to those services and
# registers them in the console; the runbook's "Grafana -> X-Ray data source,
# filter by trace_id" workflow needs XRAY, and every SLO panel needs
# CLOUDWATCH.
#
# Authentication is IAM Identity Center (the account already has an instance).
# User assignment is deliberately NOT in Terraform: aws_grafana_role_association
# needs Identity Center user/group IDs, which are per-person and would put
# teammate identifiers in version control. See infra/README for the one CLI
# call that grants a person ADMIN or EDITOR.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "grafana_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["grafana.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "grafana" {
  name               = "${local.prefix}-grafana"
  description        = "Amazon Managed Grafana workspace: reads CloudWatch metrics and X-Ray traces"
  assume_role_policy = data.aws_iam_policy_document.grafana_assume.json

  tags = {
    Name    = "${local.prefix}-grafana"
    service = "platform"
    owner   = "meron"
  }
}

# Read-only. Grafana renders our telemetry; it never writes to it. Scoped to
# the read verbs rather than attaching CloudWatchReadOnlyAccess so the grant
# stays auditable against the threat model.
data "aws_iam_policy_document" "grafana" {
  statement {
    sid    = "ReadCloudWatchMetrics"
    effect = "Allow"
    actions = [
      "cloudwatch:DescribeAlarmsForMetric",
      "cloudwatch:DescribeAlarmHistory",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:ListMetrics",
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:GetInsightRuleReport",
    ]
    resources = ["*"]
  }

  # Log Insights, for correlating a panel with the service log group.
  statement {
    sid    = "ReadLogs"
    effect = "Allow"
    actions = [
      "logs:DescribeLogGroups",
      "logs:GetLogGroupFields",
      "logs:StartQuery",
      "logs:StopQuery",
      "logs:GetQueryResults",
      "logs:GetLogEvents",
    ]
    resources = ["*"]
  }

  # The runbook's trace workflow: pull trace_id from an alert, open it here.
  statement {
    sid    = "ReadXRay"
    effect = "Allow"
    actions = [
      "xray:BatchGetTraces",
      "xray:GetTraceSummaries",
      "xray:GetTraceGraph",
      "xray:GetGroups",
      "xray:GetTimeSeriesServiceStatistics",
      "xray:GetInsightSummaries",
      "xray:GetInsight",
    ]
    resources = ["*"]
  }

  # Resource tags power Grafana's per-service template variables, so a panel
  # can filter by the `service` tag rather than hardcoding four copies.
  statement {
    sid    = "ReadResourceTags"
    effect = "Allow"
    actions = [
      "tag:GetResources",
      "ec2:DescribeRegions",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "grafana" {
  name   = "${local.prefix}-grafana"
  role   = aws_iam_role.grafana.id
  policy = data.aws_iam_policy_document.grafana.json
}

resource "aws_grafana_workspace" "main" {
  name        = local.prefix
  description = "TillFlow uptime / SLO / error-budget dashboards (G3)"

  account_access_type      = "CURRENT_ACCOUNT"
  authentication_providers = ["AWS_SSO"]
  permission_type          = "SERVICE_MANAGED"
  role_arn                 = aws_iam_role.grafana.arn

  # Registers the data sources and lets the service-managed policy read them.
  data_sources = ["CLOUDWATCH", "XRAY"]

  grafana_version = "12.4"

  tags = {
    Name    = local.prefix
    service = "platform"
    owner   = "meron"
  }
}

# ---------------------------------------------------------------------------
# Error-budget burn-rate alarms (G3 review, P1)
#
# The review's finding was exact: the multi-window burn-rate policy is fully
# specified in docs/slo-error-budgets.md and the SLI counters reach CloudWatch,
# but no alarm read them -- so the budget existed on paper and as metrics, and
# was not enforced. These alarms close that loop.
#
# Two documents own the numbers here and neither is this file:
#   - docs/slo-error-budgets.md (Rigbe, Area 4) -- targets, and the 14.4x/6x
#     multi-window policy.
#   - evidence/payments-integrity/metrics.md (Nebyat) -- which label values are
#     `good`, which are `bad`, and which are excluded from both halves.
# Changing a threshold or a label mapping means changing those, then this.
#
# Three constraints discovered against the live account, all of which shape the
# math below (the last two were flagged in metrics.md and confirmed here):
#
#   1. The namespace is `TillFlow`, FLAT -- not `TillFlow/<service>`. The awsemf
#      exporter (ecs.tf) publishes there. Services are told apart by the
#      `OTelLib` dimension (`@tillflow/pos`), which is the instrumentation scope
#      name, NOT `service.name`. An alarm written against `TillFlow/pos` or
#      against a `service.name` dimension sits in INSUFFICIENT_DATA forever.
#
#   2. `dimension_rollup_option = "NoDimensionRollup"` means there is no
#      pre-aggregated "all results" series. The denominator has to be built by
#      summing each `result` series explicitly -- hence the metric math below
#      rather than a single metric with a Sum statistic.
#
#   3. A series only exists once it has been emitted at least once. A service
#      that has never returned `result=error` has no such series, and metric
#      math over a missing series yields no data rather than zero. That is why
#      every burn-rate alarm here sets `treat_missing_data = "notBreaching"`:
#      "we have not seen an error yet" must not read as a breach.
#
# POS only, deliberately. The Payments equivalents are mechanical to write from
# the mapping in evidence/payments-integrity/metrics.md, but
# `payments_command_total` has never been emitted: a full-flow k6 run on
# 2026-09-21 created real charges and every STK push timed out against unset
# Daraja sandbox credentials, so only `payments_reconcile_total{unqueryable}`
# exists. Writing alarms against an unverified dimension set is how an alarm
# ends up sitting in INSUFFICIENT_DATA forever while looking correct in
# Terraform -- the failure this whole block exists to avoid. Unblocked by
# working credentials in devops-g1/daraja (Area 2).
# See evidence/reliability-ops/k6-fullflow-run.md.
# ---------------------------------------------------------------------------

locals {
  # Burn rate = error_rate / (1 - target). Alarming on burn >= N is the same as
  # alarming on error_rate >= N * (1 - target), and expressing it that way keeps
  # the CloudWatch expression to one division instead of two.
  #
  # POS target 99.9% -> budget 0.001
  #   fast: 14.4 * 0.001 = 0.0144  (1.44% of sale writes failing)
  #   slow:  6.0 * 0.001 = 0.006   (0.6%)
  pos_fast_burn_error_rate = 14.4 * (1 - 0.999)
  pos_slow_burn_error_rate = 6.0 * (1 - 0.999)

  # The instrumentation scope name OpenTelemetry stamps on the metric; it is
  # how CloudWatch tells the four services apart inside the one namespace.
  otel_scope = {
    pos        = "@tillflow/pos"
    payments   = "@tillflow/payments"
    commission = "@tillflow/commission"
  }
}

# --- POS: fast burn (page) -------------------------------------------------
#
# docs/slo-error-budgets.md POS row: a valid sale write that returns the correct
# response and results in exactly one row is a success -- and an idempotent
# replay returning the first response counts as success, explicitly. So `ok`,
# `idempotent` and `unique_violation` are all in the numerator: the last is the
# same correct outcome as `idempotent`, reached through a concurrent race that
# the composite primary key resolved (services/pos/src/metrics.ts).
#
# There is no `result=error` value today -- POS records nothing for a 4xx,
# because the SLO excludes client errors from both halves. The `bad` series is
# therefore whatever future outcome is added as not-good; the math is written so
# that adding one starts burning budget without editing this alarm.
resource "aws_cloudwatch_metric_alarm" "pos_fast_burn" {
  alarm_name          = "${local.prefix}-pos-budget-fast-burn"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = local.pos_fast_burn_error_rate
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  treat_missing_data  = "notBreaching"

  # The policy requires burn >= 14.4x over 1h AND over 5m, so that a short
  # spike does not page and a slow bleed does not hide. CloudWatch cannot
  # express a two-window AND in one metric alarm, so each window is its own
  # alarm and the composite below does the AND.
  metric_query {
    id          = "error_rate_1h"
    expression  = "IF(total > 0, bad / total, 0)"
    label       = "POS sale-write error rate (1h)"
    return_data = true
  }

  metric_query {
    id         = "bad"
    expression = "SUM(REMOVE_EMPTY([err]))"
    label      = "failed sale writes"
  }

  metric_query {
    id         = "total"
    expression = "SUM(REMOVE_EMPTY([ok, idem, uniq, err]))"
    label      = "eligible sale writes"
  }

  dynamic "metric_query" {
    for_each = {
      ok   = "ok"
      idem = "idempotent"
      uniq = "unique_violation"
      err  = "error"
    }

    content {
      id = metric_query.key

      metric {
        metric_name = "pos_sale_write_total"
        namespace   = "TillFlow"
        period      = 3600
        stat        = "Sum"

        dimensions = {
          result  = metric_query.value
          OTelLib = local.otel_scope["pos"]
        }
      }
    }
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = "pos"
    symptom      = "POS is burning its error budget 14.4x faster than sustainable (1h window)."
    impact       = "At this rate the entire 28-day budget is gone in ~2 days. Sale writes are failing for real attendants."
    observed     = "pos_sale_write_total error rate >= ${format("%.2f", local.pos_fast_burn_error_rate * 100)}% over 1h (target 99.9%)."
    runbook      = "docs/runbook.md#210-error-budget-burn"
    owner        = local.service_owner["pos"]
    first_action = "This is a page, not a ticket. Check whether a deploy preceded it (/version vs last-good digest) and roll back if so. If not, check RDS health and the pos_sale_write_total{result} breakdown -- unique_violation rising alone is a concurrency signal, not an outage."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-pos-budget-fast-burn"
    service = "pos"
    owner   = local.service_owner["pos"]
  }
}

# --- POS: fast burn, short window ------------------------------------------
#
# The 5m half of the fast-burn pair. Exists to be ANDed by the composite alarm;
# it deliberately does NOT publish to SNS on its own, or every brief spike would
# page while the 1h window is still well inside budget.
resource "aws_cloudwatch_metric_alarm" "pos_fast_burn_short" {
  alarm_name          = "${local.prefix}-pos-budget-fast-burn-5m"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = local.pos_fast_burn_error_rate
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "error_rate_5m"
    expression  = "IF(total > 0, bad / total, 0)"
    label       = "POS sale-write error rate (5m)"
    return_data = true
  }

  metric_query {
    id         = "bad"
    expression = "SUM(REMOVE_EMPTY([err]))"
    label      = "failed sale writes"
  }

  metric_query {
    id         = "total"
    expression = "SUM(REMOVE_EMPTY([ok, idem, uniq, err]))"
    label      = "eligible sale writes"
  }

  dynamic "metric_query" {
    for_each = {
      ok   = "ok"
      idem = "idempotent"
      uniq = "unique_violation"
      err  = "error"
    }

    content {
      id = metric_query.key

      metric {
        metric_name = "pos_sale_write_total"
        namespace   = "TillFlow"
        period      = 300
        stat        = "Sum"

        dimensions = {
          result  = metric_query.value
          OTelLib = local.otel_scope["pos"]
        }
      }
    }
  }

  alarm_description = "Short-window half of the POS fast-burn pair. Not routed to Slack on its own -- see ${local.prefix}-pos-budget-fast-burn-page."

  tags = {
    Name    = "${local.prefix}-pos-budget-fast-burn-5m"
    service = "pos"
    owner   = local.service_owner["pos"]
  }
}

# --- POS: the actual page --------------------------------------------------
#
# Google's multi-window rule: alert only when BOTH the long and short windows
# are burning. The long window is the signal; the short window is what stops a
# recovered incident from alerting for another hour.
resource "aws_cloudwatch_composite_alarm" "pos_fast_burn_page" {
  alarm_name = "${local.prefix}-pos-budget-fast-burn-page"

  alarm_rule = join(" AND ", [
    "ALARM(${aws_cloudwatch_metric_alarm.pos_fast_burn.alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.pos_fast_burn_short.alarm_name})",
  ])

  alarm_description = jsonencode({
    environment  = var.environment
    service      = "pos"
    symptom      = "POS fast burn: error budget consuming at >= 14.4x over BOTH the 1h and 5m windows."
    impact       = "~2% of the 28-day budget per hour. Page the area DRI; this is an incident."
    observed     = "Both ${local.prefix}-pos-budget-fast-burn and -5m are in ALARM."
    runbook      = "docs/runbook.md#210-error-budget-burn"
    owner        = local.service_owner["pos"]
    first_action = "Start an incident. Consider rollback or a feature flag before debugging -- docs/slo-error-budgets.md's fast-burn row says stop the burn first."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-pos-budget-fast-burn-page"
    service = "pos"
    owner   = local.service_owner["pos"]
  }
}

# --- POS: slow burn (ticket) -----------------------------------------------
#
# 6x over 6h AND over 30m. Same two-window structure as the page, different
# thresholds and a different action: docs/slo-error-budgets.md routes this to a
# Slack ticket for same-day investigation, not a page. A slow burn is the one
# that quietly eats a month of budget without any single hour looking alarming.
resource "aws_cloudwatch_metric_alarm" "pos_slow_burn" {
  alarm_name          = "${local.prefix}-pos-budget-slow-burn"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = local.pos_slow_burn_error_rate
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "error_rate_6h"
    expression  = "IF(total > 0, bad / total, 0)"
    label       = "POS sale-write error rate (6h)"
    return_data = true
  }

  metric_query {
    id         = "bad"
    expression = "SUM(REMOVE_EMPTY([err]))"
    label      = "failed sale writes"
  }

  metric_query {
    id         = "total"
    expression = "SUM(REMOVE_EMPTY([ok, idem, uniq, err]))"
    label      = "eligible sale writes"
  }

  dynamic "metric_query" {
    for_each = {
      ok   = "ok"
      idem = "idempotent"
      uniq = "unique_violation"
      err  = "error"
    }

    content {
      id = metric_query.key

      metric {
        metric_name = "pos_sale_write_total"
        namespace   = "TillFlow"
        # 6h. CloudWatch caps a metric-math period at 1 day, so this is fine,
        # but note it also means the alarm cannot evaluate faster than 6h --
        # which is the point: this is the window, not the sampling rate.
        period = 21600
        stat   = "Sum"

        dimensions = {
          result  = metric_query.value
          OTelLib = local.otel_scope["pos"]
        }
      }
    }
  }

  alarm_description = "Long-window half of the POS slow-burn pair. Not routed to Slack on its own -- see ${local.prefix}-pos-budget-slow-burn-ticket."

  tags = {
    Name    = "${local.prefix}-pos-budget-slow-burn"
    service = "pos"
    owner   = local.service_owner["pos"]
  }
}

resource "aws_cloudwatch_metric_alarm" "pos_slow_burn_short" {
  alarm_name          = "${local.prefix}-pos-budget-slow-burn-30m"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = local.pos_slow_burn_error_rate
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "error_rate_30m"
    expression  = "IF(total > 0, bad / total, 0)"
    label       = "POS sale-write error rate (30m)"
    return_data = true
  }

  metric_query {
    id         = "bad"
    expression = "SUM(REMOVE_EMPTY([err]))"
    label      = "failed sale writes"
  }

  metric_query {
    id         = "total"
    expression = "SUM(REMOVE_EMPTY([ok, idem, uniq, err]))"
    label      = "eligible sale writes"
  }

  dynamic "metric_query" {
    for_each = {
      ok   = "ok"
      idem = "idempotent"
      uniq = "unique_violation"
      err  = "error"
    }

    content {
      id = metric_query.key

      metric {
        metric_name = "pos_sale_write_total"
        namespace   = "TillFlow"
        period      = 1800
        stat        = "Sum"

        dimensions = {
          result  = metric_query.value
          OTelLib = local.otel_scope["pos"]
        }
      }
    }
  }

  alarm_description = "Short-window half of the POS slow-burn pair. Not routed to Slack on its own -- see ${local.prefix}-pos-budget-slow-burn-ticket."

  tags = {
    Name    = "${local.prefix}-pos-budget-slow-burn-30m"
    service = "pos"
    owner   = local.service_owner["pos"]
  }
}

resource "aws_cloudwatch_composite_alarm" "pos_slow_burn_ticket" {
  alarm_name = "${local.prefix}-pos-budget-slow-burn-ticket"

  alarm_rule = join(" AND ", [
    "ALARM(${aws_cloudwatch_metric_alarm.pos_slow_burn.alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.pos_slow_burn_short.alarm_name})",
  ])

  alarm_description = jsonencode({
    environment  = var.environment
    service      = "pos"
    symptom      = "POS slow burn: error budget consuming at >= 6x over BOTH the 6h and 30m windows."
    impact       = "~5% of the 28-day budget per 6h. Not a page, but it ends the month over budget if left."
    observed     = "Both ${local.prefix}-pos-budget-slow-burn and -30m are in ALARM."
    runbook      = "docs/runbook.md#210-error-budget-burn"
    owner        = local.service_owner["pos"]
    first_action = "Investigate today, not now. Break pos_sale_write_total down by result: a steady unique_violation rate is concurrency, a steady error rate is a dependency. Neither needs a rollback unless it started at a deploy."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-pos-budget-slow-burn-ticket"
    service = "pos"
    owner   = local.service_owner["pos"]
  }
}

# --- POS: budget remaining < 25% (release freeze) --------------------------
#
# The freeze trigger from docs/slo-error-budgets.md. Distinct from burn RATE:
# this is cumulative consumption over the whole 28-day window, so it fires on
# "we have spent too much" regardless of how fast we are spending right now.
#
# A metric alarm CANNOT span 28 days. CloudWatch enforces
# `EvaluationPeriods * Period <= 604800` (7 days) for any alarm with a period of
# an hour or more, and rejects anything longer at PutMetricAlarm time -- not at
# plan time, which is why a first attempt at 1-day x 28 periods passed
# `terraform plan` and failed `terraform apply`:
#
#   ValidationError: Metrics cannot be checked across more than a week
#   (EvaluationPeriods * Period must be <= 604800) for alarms using period >= 3600
#
# So this is a 7-day window: the longest CloudWatch will evaluate, and exactly
# a quarter of the SLO's 28-day budget period. Read it as an early warning --
# "the last 7 days have been burning at a rate that spends the whole 28-day
# budget" -- rather than as a literal budget-remaining calculation.
#
# The literal figure needs a rolling 28-day sum, which means either a Lambda
# publishing a computed metric or a Grafana panel doing the math at query time.
# The panel is the right home for it (docs/slo-error-budgets.md is Area 4's, and
# `evidence/reliability-ops/grafana-dashboard-spec.md` already lists a
# "budget remaining" panel); this alarm exists so the freeze trigger is not
# purely a dashboard someone has to remember to look at.
resource "aws_cloudwatch_metric_alarm" "pos_budget_low" {
  alarm_name          = "${local.prefix}-pos-budget-below-25pct"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # 75% of a 0.1% budget consumed == a sustained error rate of 0.075%.
  threshold = 0.75 * (1 - 0.999)
  # 7 x 1 day = 604800s exactly, the maximum CloudWatch allows.
  evaluation_periods  = 7
  datapoints_to_alarm = 7
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "error_rate_28d"
    expression  = "IF(total > 0, bad / total, 0)"
    label       = "POS sale-write error rate (daily, 28d window)"
    return_data = true
  }

  metric_query {
    id         = "bad"
    expression = "SUM(REMOVE_EMPTY([err]))"
    label      = "failed sale writes"
  }

  metric_query {
    id         = "total"
    expression = "SUM(REMOVE_EMPTY([ok, idem, uniq, err]))"
    label      = "eligible sale writes"
  }

  dynamic "metric_query" {
    for_each = {
      ok   = "ok"
      idem = "idempotent"
      uniq = "unique_violation"
      err  = "error"
    }

    content {
      id = metric_query.key

      metric {
        metric_name = "pos_sale_write_total"
        namespace   = "TillFlow"
        period      = 86400
        stat        = "Sum"

        dimensions = {
          result  = metric_query.value
          OTelLib = local.otel_scope["pos"]
        }
      }
    }
  }

  alarm_description = jsonencode({
    environment  = var.environment
    service      = "pos"
    symptom      = "POS has been burning error budget at a 28-day-exhausting rate for 7 consecutive days."
    impact       = "Release freeze on pos: only reliability fixes and rollbacks merge until the budget recovers above 50%."
    observed     = "Sale-write error rate sustained above ${format("%.3f", 0.75 * (1 - 0.999) * 100)}% for 7 consecutive days (target 99.9%). CloudWatch caps an alarm window at 7 days, so this is the early-warning proxy for the 28-day budget; the exact remaining figure is the Grafana budget panel."
    runbook      = "docs/runbook.md#210-error-budget-burn"
    owner        = local.service_owner["pos"]
    first_action = "Announce the freeze in the group channel, then stop shipping features to pos. docs/slo-error-budgets.md's budget policy says the freeze lifts when the rolling window recovers above 50%, not when someone judges it fixed."
  })

  alarm_actions = local.alert_topic
  ok_actions    = local.alert_topic

  tags = {
    Name    = "${local.prefix}-pos-budget-below-25pct"
    service = "pos"
    owner   = local.service_owner["pos"]
  }
}
