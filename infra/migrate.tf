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

# Accepted risk: same rationale as the service egress rule in ecs.tf -- the task
# needs Secrets Manager, ECR and CloudWatch Logs, which have no stable CIDR, and
# this is 443 only. Owner: meron. Expiry: G5.
# trivy:ignore:AVD-AWS-0104
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

# One task definition per migrated service.
#
# `containerOverrides` has no image field, so a single definition pinned to the
# POS image could never run the Payments migration -- the schema and role would
# never be created, and payments and commission would never start. Each service's
# migrations ship inside its own image, so each needs its own definition.
#
# `commission` has no migration: it shares the payments schema and role (ADR
# 0003). `web` has no database at all.
#
# Accepted risk: AWS-0036 matches on the env var NAME `DB_SECRET_PREFIX`, never
# on its value -- which is `devops-g1`, the resource prefix printed in every ARN
# in this repo. The one genuinely sensitive input, ADMIN_DATABASE_URL, is in
# `secrets` (resolved from Secrets Manager at container start), never in
# `environment`: exactly the distinction this rule exists to enforce.
#
# Renaming was tried first and is worse: the migrator's other accepted variable,
# DB_PASSWORD_SECRET_ID, trips the same pattern harder, and an inline ignore does
# not work because Trivy attributes the finding to the whole resource block.
#
# The suppression is resource-wide, so it WOULD also hide a real plaintext secret
# added to `environment` later. `infra/scripts/audit.sh --env-secrets` closes
# that hole with a narrower check; the IaC scan alone no longer covers it here.
# Owner: meron. Expiry: G5.
# trivy:ignore:AVD-AWS-0036
resource "aws_ecs_task_definition" "migrate" {
  for_each = toset(["pos", "payments"])

  family                   = "${local.prefix}-migrate-${each.key}"
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

    # The service's OWN image -- the migrations ship inside it, so the schema
    # applied always matches the code that will read it.
    image     = local.service_image[each.key] != "" ? local.service_image[each.key] : local.placeholder_image
    essential = true

    # `node dist/migrate.js`, not npm: the runtime image deletes npm/yarn and
    # strips devDependencies, so neither npm nor tsx exists in it. The migrator
    # lives in src/ and compiles into dist/, which the image already copies.
    #
    # No override needed -- each definition already knows which service it is, so
    # `run-task` with no `--overrides` does the right thing.
    command = ["node", "dist/migrate.js", "--write-secret"]

    user                   = "1000:1000"
    readonlyRootFilesystem = true

    # APP_SERVICE / APP_SCHEMA / APP_ROLE are baked in rather than passed per
    # invocation: they are a property of which image this is, not of the run.
    # `commission` shares the payments schema and role, so it appears nowhere.
    environment = [
      { name = "ENVIRONMENT", value = var.environment },
      { name = "AWS_REGION", value = var.aws_region },
      # No trailing slash: the migrator builds `${prefix}/${APP_SERVICE}/db-password`
      # from this (services/*/src/migrate.ts), so "devops-g1/" would resolve to
      # `devops-g1//pos/db-password` -- a secret that does not exist, so the write
      # fails and `database_url` is never populated.
      { name = "DB_SECRET_PREFIX", value = local.prefix },
      { name = "APP_SERVICE", value = each.key },
      { name = "APP_SCHEMA", value = each.key },
      { name = "APP_ROLE", value = "${local.prefix}-${each.key}-app" },
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
    Name    = "${local.prefix}-migrate-${each.key}"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

output "migrate_run_task_command" {
  description = "Copy-paste for the runbook: run each service's migrations once."

  # One command per service, because each runs its own image. APP_SERVICE,
  # APP_SCHEMA and APP_ROLE are already in the task definition, so no
  # `--overrides` is needed -- which also means there is no way to run the wrong
  # migration against the wrong image by fumbling a flag.
  #
  # Commission needs no run of its own: it shares the payments schema and role.
  value = join("\n\n", [
    for s in ["pos", "payments"] : <<-CMD
      # ${s}
      aws ecs run-task \
        --cluster ${aws_ecs_cluster.main.name} \
        --task-definition ${aws_ecs_task_definition.migrate[s].family} \
        --launch-type FARGATE \
        --network-configuration 'awsvpcConfiguration={subnets=[${join(",", [for sn in aws_subnet.private : sn.id])}],securityGroups=[${aws_security_group.migrate.id}],assignPublicIp=DISABLED}'
    CMD
  ])
}
