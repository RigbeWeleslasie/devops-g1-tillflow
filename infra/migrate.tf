# migrate.tf — one-off database migration task (contract §4).
#
# DRI: Meron (Platform + delivery).
#
# A task definition with no service behind it: run on demand with
# `aws ecs run-task`, it exits, and nothing runs until the next time. Nebyat
# argued for this over a CodeBuild stage and the reasoning holds:
#
#   Blast radius -- the job needs ADMIN_DATABASE_URL, the RDS master credential,
#     to create schemas and least-privilege roles. In the pipeline, the pipeline
#     role would hold that permission permanently. Here only this task role does,
#     and only while a task is actually running.
#
#   It is not per-deploy -- it creates the pos/payments schemas and two roles,
#     then applies ordered migrations. Running it on every deploy couples a
#     schema change to a code deploy, which is backwards: the migration must land
#     BEFORE the code that needs it.
#
#   G5 wants reproducibility -- a documented `aws ecs run-task` in the runbook is
#     better destroy/rebuild evidence than a pipeline stage someone remembers to
#     trigger.
#
# Commission needs no migration of its own: it shares the payments schema and
# role (ADR 0003).

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/${local.prefix}/migrate"
  retention_in_days = 14

  tags = {
    Name    = "/${local.prefix}/migrate"
    service = "platform"
    owner   = "meron"
  }
}

# --- roles -----------------------------------------------------------------
# Separate from the service roles: this is the only identity in the stack that
# may read the RDS master credential or write the per-service DB secrets.

resource "aws_iam_role" "migrate_exec" {
  name               = "${local.prefix}-migrate-exec"
  description        = "ECS agent role for the one-off migration task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json

  tags = {
    Name    = "${local.prefix}-migrate-exec"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_iam_role_policy_attachment" "migrate_exec_managed" {
  role       = aws_iam_role.migrate_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "migrate_exec" {
  statement {
    sid       = "ReadMasterCredential"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db.arn]
  }

  statement {
    sid       = "DecryptSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "migrate_exec" {
  name   = "${local.prefix}-migrate-exec"
  role   = aws_iam_role.migrate_exec.id
  policy = data.aws_iam_policy_document.migrate_exec.json
}

resource "aws_iam_role" "migrate_task" {
  name               = "${local.prefix}-migrate-task"
  description        = "Application role for the migration job: writes the per-service DB secrets"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json

  tags = {
    Name    = "${local.prefix}-migrate-task"
    service = "platform"
    owner   = "meron"
  }
}

data "aws_iam_policy_document" "migrate_task" {
  # `--write-secret` puts the generated app password where the running service
  # reads it from. Write-only on those paths: the job creates credentials, it
  # never needs to read one back.
  statement {
    sid    = "WriteServiceDbSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecretVersionStage",
      "secretsmanager:DescribeSecret",
    ]
    resources = [for s in local.services : aws_secretsmanager_secret.service_db_password[s].arn]
  }

  statement {
    sid       = "DecryptSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.secrets.arn]
  }

  statement {
    sid    = "Telemetry"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "migrate_task" {
  name   = "${local.prefix}-migrate-task"
  role   = aws_iam_role.migrate_task.id
  policy = data.aws_iam_policy_document.migrate_task.json
}

# --- security group --------------------------------------------------------
# Its own SG rather than borrowing a service's: the migration job connects as
# the DB master, and that reach should not be attached to a long-running
# service's identity.

resource "aws_security_group" "migrate" {
  name        = "${local.prefix}-migrate"
  description = "One-off migration task: egress to RDS and HTTPS only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name    = "${local.prefix}-migrate"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_vpc_security_group_egress_rule" "migrate_to_rds" {
  security_group_id            = aws_security_group.migrate.id
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "To PostgreSQL as the master user"

  tags = {
    Name    = "${local.prefix}-migrate-to-rds"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_vpc_security_group_egress_rule" "migrate_https" {
  security_group_id = aws_security_group.migrate.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
  description       = "Secrets Manager, ECR and CloudWatch Logs"

  tags = {
    Name    = "${local.prefix}-migrate-https"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_migrate" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.migrate.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from the migration task"

  tags = {
    Name    = "${local.prefix}-rds-from-migrate"
    service = "platform"
    owner   = "meron"
  }
}

# --- task definition -------------------------------------------------------

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.prefix}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.migrate_exec.arn
  task_role_arn            = aws_iam_role.migrate_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name = "migrate"

    # Runs the service's own image -- the migrations ship inside it, so the
    # schema applied always matches the code that will read it. `--overrides` on
    # run-task selects which service and supplies the command.
    image     = local.service_image["pos"] != "" ? local.service_image["pos"] : local.placeholder_image
    essential = true

    # Overridden per invocation; a no-op default so a bare run-task does nothing
    # destructive. The real command is `node dist/migrate.js --write-secret`
    # with APP_SERVICE / APP_SCHEMA / APP_ROLE supplied per run -- see
    # `migrate_run_task_command` below and docs/runbook.md.
    command = ["node", "-e", "console.log('pass --overrides to select a service; see docs/runbook.md')"]

    user                   = "1000:1000"
    readonlyRootFilesystem = true

    environment = [
      { name = "ENVIRONMENT", value = var.environment },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "DB_SECRET_PREFIX", value = "${local.prefix}/" },
    ]

    secrets = [
      # The master credential, and only here. No long-running service has it.
      { name = "ADMIN_DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.db.arn}:database_url::" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.migrate.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }])

  tags = {
    Name    = "${local.prefix}-migrate"
    service = "platform"
    owner   = "meron"
  }
}

output "migrate_run_task_command" {
  description = "Copy-paste for the runbook: run one service's migrations."

  # `node dist/migrate.js`, not npm: the runtime image deletes npm/yarn and
  # strips devDependencies, so neither npm nor tsx exists in it. The migrator
  # lives in src/ and compiles into dist/, which the image already copies.
  #
  # APP_SERVICE / APP_SCHEMA / APP_ROLE are read by the migrator, so one task
  # definition covers both services -- but only for images that contain both
  # migrators. `containerOverrides` has no image field, so a POS image cannot run
  # the Payments migration: run each against a task definition built from its own
  # image, or from one image carrying both.
  value = <<-EOT
    # POS
    aws ecs run-task \
      --cluster ${aws_ecs_cluster.main.name} \
      --task-definition ${aws_ecs_task_definition.migrate.family} \
      --launch-type FARGATE \
      --network-configuration 'awsvpcConfiguration={subnets=[${join(",", [for s in aws_subnet.private : s.id])}],securityGroups=[${aws_security_group.migrate.id}],assignPublicIp=DISABLED}' \
      --overrides '{"containerOverrides":[{"name":"migrate",
        "command":["node","dist/migrate.js","--write-secret"],
        "environment":[{"name":"APP_SERVICE","value":"pos"},
                       {"name":"APP_SCHEMA","value":"pos"},
                       {"name":"APP_ROLE","value":"${local.prefix}-pos-app"}]}]}'

    # Payments (commission shares this schema and role -- no separate run)
    # ... same, with APP_SERVICE=payments, APP_SCHEMA=payments,
    #     APP_ROLE=${local.prefix}-payments-app
  EOT
}
