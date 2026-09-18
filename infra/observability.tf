# observability.tf — alarms, dashboards, synthetic probe.
#
# DRI: Meron (Platform + delivery) owns the Terraform. The SLI/SLO definitions,
# burn-rate policy and alert contract this implements are Rigbe's
# (docs/slo-error-budgets.md, docs/runbook.md, Area 4 in docs/ownership.md).
# Where a threshold here encodes a number, that number comes from those docs
# rather than from this file's own judgement.
#
# G3 blockers this addresses:
#   - "no external probe"   -> aws_synthetics_canary.uptime, below
#   - "no actionable alert" -> alarm -> SNS -> Slack (added next)
#   - "no per-service budget" -> burn-rate alarms, once services emit the SLI
#     counters the shared OTel bootstrap now supports

# ---------------------------------------------------------------------------
# External uptime probe
#
# Runs in the Synthetics-managed environment OUTSIDE our VPC and calls the
# public API Gateway endpoint, so it fails on the edge failures that every
# in-network check is blind to: API Gateway 5xx, a dead VPC Link, a bad route.
# ---------------------------------------------------------------------------

data "archive_file" "canary" {
  type        = "zip"
  output_path = "${path.module}/.terraform/tmp/canary-probe.zip"

  source {
    content = file("${path.module}/canary/probe.js")
    # Synthetics requires exactly this layout for a nodejs runtime: the handler
    # is addressed as `probe.handler`, and the file must sit under
    # nodejs/node_modules/ or the canary starts and immediately errors with a
    # module-not-found that does not name the real problem.
    filename = "nodejs/node_modules/probe.js"
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
  description        = "AWS Synthetics external uptime probe"
  assume_role_policy = data.aws_iam_policy_document.canary_assume.json

  tags = {
    Name    = "${local.prefix}-canary"
    service = "platform"
    owner   = "meron"
  }
}

data "aws_iam_policy_document" "canary" {
  # Artifact upload, scoped to this canary's prefix rather than the bucket.
  statement {
    sid       = "WriteArtifacts"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.logs.arn}/canary/*"]
  }

  statement {
    sid       = "ResolveArtifactLocation"
    effect    = "Allow"
    actions   = ["s3:GetBucketLocation"]
    resources = [aws_s3_bucket.logs.arn]
  }

  statement {
    sid       = "ListArtifactPrefix"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.logs.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["canary", "canary/", "canary/*"]
    }
  }

  # Synthetics calls ListAllMyBuckets to resolve the artifact location; it
  # cannot be scoped to one bucket, so it is granted alone rather than by
  # widening the statement above.
  statement {
    sid       = "ResolveArtifactBucket"
    effect    = "Allow"
    actions   = ["s3:ListAllMyBuckets"]
    resources = ["*"]
  }

  statement {
    sid     = "Logs"
    effect  = "Allow"
    actions = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "arn:aws:logs:${var.aws_region}:${local.account_id}:log-group:/aws/lambda/cwsyn-${local.prefix}-*",
      "arn:aws:logs:${var.aws_region}:${local.account_id}:log-group:/aws/lambda/cwsyn-${local.prefix}-*:*",
    ]
  }

  # The canary's own pass/fail metrics. Namespace-scoped for the same reason
  # the task roles are (iam.tf): PutMetricData cannot be resource-scoped, so
  # the namespace condition is the only control available.
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

resource "aws_synthetics_canary" "uptime" {
  # Synthetics prefixes the underlying Lambda with "cwsyn-" and caps the total
  # at 21 characters, so this name is kept short deliberately.
  name                 = "${local.prefix}-uptime"
  artifact_s3_location = "s3://${aws_s3_bucket.logs.id}/canary/"
  execution_role_arn   = aws_iam_role.canary.arn
  handler              = "probe.handler"
  zip_file             = data.archive_file.canary.output_path
  # syn-nodejs-5.2: current non-deprecated API runtime. Deliberately not a
  # puppeteer/playwright runtime -- this probes JSON endpoints, and a headless
  # browser would add cold-start latency to a measurement whose whole job is to
  # be a latency baseline.
  runtime_version = "syn-nodejs-5.2"

  start_canary = true

  schedule {
    expression = var.canary_schedule_expression
  }

  run_config {
    # Comfortably under the 60s schedule so a slow run cannot overlap the next.
    timeout_in_seconds = 45
    memory_in_mb       = 960
    active_tracing     = false

    environment_variables = {
      TARGET_BASE_URL = aws_apigatewayv2_api.main.api_endpoint
      TARGET_SERVICES = join(",", var.canary_target_services)
    }
  }

  success_retention_period = 7
  failure_retention_period = 30

  tags = {
    Name    = "${local.prefix}-uptime"
    service = "platform"
    owner   = "meron"
  }

  depends_on = [aws_iam_role_policy.canary]
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
    CanaryName = aws_synthetics_canary.uptime.name
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
      "Check the canary's failed step in the CloudWatch Synthetics console --",
      "the step name identifies which service failed. Then confirm whether the",
      "ALB target group is healthy: if targets are healthy the fault is at the",
      "edge (API Gateway route or VPC Link), not in the service."
    ])
  })

  tags = {
    Name    = "${local.prefix}-uptime-probe-failing"
    service = "platform"
    owner   = "meron"
  }
}
