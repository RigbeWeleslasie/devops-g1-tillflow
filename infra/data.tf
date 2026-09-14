# data.tf — RDS PostgreSQL, ElastiCache, SQS + DLQ, EventBridge schedule.
#
# DRI: Meron (Platform + delivery). Sizing and durability per ADR 0003.
#
# Everything here lives in the private subnets and is reachable only from the
# service security groups -- no public access, no cross-service reach.

# ---------------------------------------------------------------------------
# Security groups — one per data service, referenced by service SGs only
# ---------------------------------------------------------------------------

resource "aws_security_group" "rds" {
  name        = "${local.prefix}-rds"
  description = "RDS PostgreSQL: from application tasks only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name    = "${local.prefix}-rds"
    service = "platform"
    owner   = "meron"
  }
}

# docs/threat-model.md line 48: "pos SG cannot reach payments DB port". One
# shared instance with per-schema roles (ADR 0003) means the isolation is
# enforced by GRANTs, not by the network -- but only services that own a schema
# get network reach at all. `web` never touches the database.
resource "aws_vpc_security_group_ingress_rule" "rds_from_service" {
  for_each = toset([for s in local.services : s if s != "web"])

  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.service[each.key].id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from ${each.key}"

  tags = {
    Name    = "${local.prefix}-rds-from-${each.key}"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

resource "aws_security_group" "redis" {
  name        = "${local.prefix}-redis"
  description = "ElastiCache Valkey: from application tasks only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name    = "${local.prefix}-redis"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_service" {
  for_each = toset([for s in local.services : s if s != "web"])

  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.service[each.key].id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "Valkey from ${each.key}"

  tags = {
    Name    = "${local.prefix}-redis-from-${each.key}"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# Tasks need egress to the data tier; ecs.tf only opens 443.
resource "aws_vpc_security_group_egress_rule" "service_to_rds" {
  for_each = toset([for s in local.services : s if s != "web"])

  security_group_id            = aws_security_group.service[each.key].id
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "To PostgreSQL"

  tags = {
    Name    = "${local.prefix}-${each.key}-to-rds"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

resource "aws_vpc_security_group_egress_rule" "service_to_redis" {
  for_each = toset([for s in local.services : s if s != "web"])

  security_group_id            = aws_security_group.service[each.key].id
  referenced_security_group_id = aws_security_group.redis.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "To Valkey"

  tags = {
    Name    = "${local.prefix}-${each.key}-to-redis"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# ---------------------------------------------------------------------------
# RDS PostgreSQL (ADR 0003)
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = [for s in aws_subnet.private : s.id]

  tags = {
    Name    = local.prefix
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_kms_key" "rds" {
  description             = "${local.prefix} RDS storage encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 7

  tags = {
    Name    = "${local.prefix}-rds"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_kms_alias" "rds" {
  name          = "alias/${local.prefix}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.prefix}-pg16"
  family = "postgres16"

  # ADR 0003: TLS required.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  # Anything slower than 1s is a candidate for the k6 bottleneck analysis (G3).
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  tags = {
    Name    = "${local.prefix}-pg16"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_db_instance" "main" {
  identifier = local.prefix

  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage     = 20
  max_allocated_storage = 100 # storage autoscaling (ADR 0003)
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.rds.arn

  db_name  = var.db_name
  username = var.db_master_username
  password = random_password.db_master.result

  # Multi-AZ: synchronous standby, RPO ~0 for an AZ failure. Required for the
  # G4 AZ-failure drill.
  multi_az = var.db_multi_az

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false

  # 02:00-03:00 UTC = 05:00-06:00 EAT: after the 00:15 EAT daily close, before
  # the 06:30 EAT payout deadline (ADR 0003).
  backup_window           = "02:00-03:00"
  backup_retention_period = var.db_backup_retention_days
  maintenance_window      = "sun:03:30-sun:04:30"
  copy_tags_to_snapshot   = true

  # Verified supported on db.t4g.small (the applied instance reports
  # PerformanceInsightsEnabled: true). PI is unavailable on the smaller
  # burstable classes -- db.t2/t3.micro -- not on t4g.small. Kept because the
  # CPU-credit and load story is what the k6 bottleneck analysis rests on (G3).
  performance_insights_enabled    = true
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  # The capstone must demonstrate destroy/rebuild, so deletion protection is off
  # and a final snapshot would block the teardown. Production would invert both.
  deletion_protection = false
  skip_final_snapshot = true

  apply_immediately = true

  tags = {
    Name    = local.prefix
    service = "platform"
    owner   = "meron"
  }
}

# ---------------------------------------------------------------------------
# ElastiCache (Valkey) — cache-aside
# ---------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = [for s in aws_subnet.private : s.id]

  tags = {
    Name    = local.prefix
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = local.prefix
  description          = "TillFlow cache-aside (tenant config, rate limits)"

  engine         = "valkey"
  engine_version = var.redis_engine_version
  node_type      = var.redis_node_type
  port           = 6379

  # Two nodes across two AZs with automatic failover, so a cache AZ loss
  # degrades rather than breaks (the G4 cache-failure drill).
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.secrets.arn

  snapshot_retention_limit = 1
  snapshot_window          = "01:00-02:00"
  maintenance_window       = "sun:04:30-sun:05:30"

  apply_immediately = true

  tags = {
    Name    = local.prefix
    service = "platform"
    owner   = "meron"
  }
}

# ---------------------------------------------------------------------------
# SQS + DLQ
#
# Two queues: sale.paid events (payments -> pos) and commission payout jobs.
# Each has a dead-letter queue -- the DLQ is what the G4 "break the worker"
# drill fills and then drains.
# ---------------------------------------------------------------------------

locals {
  queues = {
    "sale-events"       = { owner = local.service_owner["pos"], service = "pos" }
    "commission-payout" = { owner = local.service_owner["commission"], service = "commission" }
  }
}

resource "aws_sqs_queue" "dlq" {
  for_each = local.queues

  name                      = "${local.prefix}-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 days: a drill needs time to inspect
  sqs_managed_sse_enabled   = true

  tags = {
    Name    = "${local.prefix}-${each.key}-dlq"
    service = each.value.service
    owner   = each.value.owner
  }
}

resource "aws_sqs_queue" "main" {
  for_each = local.queues

  name = "${local.prefix}-${each.key}"

  # Long polling: fewer empty receives, lower cost, faster delivery.
  receive_wait_time_seconds = 20

  # Long enough for a payout to reach a terminal state before redelivery.
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600 # 4 days
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    # 5 attempts: enough to ride out a transient dependency blip, few enough
    # that a poison message reaches the DLQ while someone is still watching.
    maxReceiveCount = 5
  })

  tags = {
    Name    = "${local.prefix}-${each.key}"
    service = each.value.service
    owner   = each.value.owner
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  for_each = local.queues

  queue_url = aws_sqs_queue.dlq[each.key].id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.main[each.key].arn]
  })
}

# ---------------------------------------------------------------------------
# EventBridge — daily close
# ---------------------------------------------------------------------------

resource "aws_scheduler_schedule_group" "main" {
  name = local.prefix

  tags = {
    Name    = local.prefix
    service = "platform"
    owner   = "meron"
  }
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.prefix}-scheduler"
  description        = "EventBridge Scheduler: enqueue the daily close"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json

  tags = {
    Name    = "${local.prefix}-scheduler"
    service = "commission"
    owner   = local.service_owner["commission"]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name = "${local.prefix}-scheduler"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = [aws_sqs_queue.main["commission-payout"].arn]
    }]
  })
}

# 00:15 EAT (21:15 UTC the previous day). The close runs after the trading day
# and well before the 06:30 EAT payout SLO deadline, leaving room to retry.
resource "aws_scheduler_schedule" "daily_close" {
  name       = "${local.prefix}-daily-close"
  group_name = aws_scheduler_schedule_group.main.name

  schedule_expression          = "cron(15 0 * * ? *)"
  schedule_expression_timezone = "Africa/Nairobi"

  flexible_time_window {
    mode = "OFF" # a payout deadline is not flexible
  }

  target {
    arn      = aws_sqs_queue.main["commission-payout"].arn
    role_arn = aws_iam_role.scheduler.arn

    input = jsonencode({
      type   = "daily_close"
      source = "eventbridge-scheduler"
    })

    retry_policy {
      maximum_retry_attempts       = 3
      maximum_event_age_in_seconds = 3600
    }
  }
}

# ---------------------------------------------------------------------------
# Task-role access to the data tier
# ---------------------------------------------------------------------------

# Who may read from which queue, and who may write to it. Derived from the flows
# in docs/architecture.md §4: payments publishes sale.paid and requests B2C; pos
# consumes sale.paid to move a sale to PAID; commission consumes payout jobs from
# the EventBridge daily close.
#
# A DLQ is consumable only by the service that owns the source queue -- redriving
# someone else's dead letters is the same capability as draining their queue.
locals {
  queue_consume = {
    web        = []
    pos        = [aws_sqs_queue.main["sale-events"].arn, aws_sqs_queue.dlq["sale-events"].arn]
    payments   = []
    commission = [aws_sqs_queue.main["commission-payout"].arn, aws_sqs_queue.dlq["commission-payout"].arn]
  }

  queue_produce = {
    web = []
    # pos requests a charge through the Payments API (HTTP), not a queue.
    pos = []
    # payments publishes sale.paid after a callback confirms payment.
    payments = [aws_sqs_queue.main["sale-events"].arn]
    # commission re-enqueues its own work on retry; B2C goes through the
    # Payments API, never Daraja directly (architecture.md §3, hard rule).
    commission = [aws_sqs_queue.main["commission-payout"].arn]
  }
}

data "aws_iam_policy_document" "task_data" {
  for_each = toset(local.services)

  # Queue access follows ownership, per queue and per direction.
  #
  # Granting every non-web task send+receive+delete on ALL queues would let `pos`
  # drain commission-payout and its DLQ -- exactly the lateral movement
  # docs/threat-model.md line 48 exists to prevent. Consumers may receive and
  # delete on their own queue; producers may only send to someone else's.
  dynamic "statement" {
    for_each = length(local.queue_consume[each.key]) > 0 ? [1] : []
    content {
      sid    = "ConsumeOwnQueues"
      effect = "Allow"
      actions = [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
      ]
      resources = local.queue_consume[each.key]
    }
  }

  dynamic "statement" {
    for_each = length(local.queue_produce[each.key]) > 0 ? [1] : []
    content {
      sid       = "ProduceToQueues"
      effect    = "Allow"
      actions   = ["sqs:SendMessage", "sqs:GetQueueUrl"]
      resources = local.queue_produce[each.key]
    }
  }

  # The application reads its own DB credentials at runtime. The exec role reads
  # secrets to inject as env; the task role reads them for rotation-aware
  # reconnects. Both are scoped to this service's own path.
  dynamic "statement" {
    for_each = each.key == "web" ? [] : [1]
    content {
      sid     = "ReadOwnDbSecret"
      effect  = "Allow"
      actions = ["secretsmanager:GetSecretValue"]
      resources = [
        aws_secretsmanager_secret.service_db[each.key].arn,
        aws_secretsmanager_secret.service_db_password[each.key].arn,
      ]
    }
  }

  # Only payments holds Daraja credentials. docs/architecture.md §3 makes this a
  # hard rule: commission requests B2C through the Payments API and a direct
  # Daraja call from commission fails G2.
  dynamic "statement" {
    for_each = each.key == "payments" ? [1] : []
    content {
      sid       = "ReadDarajaCredentials"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [aws_secretsmanager_secret.daraja.arn]
    }
  }

  statement {
    sid       = "DecryptSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "task_data" {
  for_each = toset(local.services)

  name   = "${local.prefix}-${each.key}-data"
  role   = aws_iam_role.task[each.key].id
  policy = data.aws_iam_policy_document.task_data[each.key].json
}
