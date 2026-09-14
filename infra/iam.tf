# iam.tf — CI deploy role (OIDC) and per-service ECS roles.
#
# DRI: Meron (Platform + delivery).
#
# No long-lived AWS keys exist anywhere in this project. GitHub Actions federates
# via OIDC and assumes devops-g1-ci-deploy; the trust policy is scoped to this
# repository so another repo presenting a valid GitHub token still cannot assume it.

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

# The provider is account-wide. On a shared cohort account another group may have
# created it already, so it is adopted when present rather than duplicated.
resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = {
    Name    = "${local.prefix}-github-oidc"
    service = "platform"
    owner   = "meron"
  }
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? one(aws_iam_openid_connect_provider.github[*].arn) : one(data.aws_iam_openid_connect_provider.github[*].arn)
}

# ---------------------------------------------------------------------------
# CI deploy role — assumed by GitHub Actions
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ci_deploy_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Scope to this repo. `sub` encodes repo + ref, so this both pins the
    # repository and limits which refs/environments may deploy.
    #
    # Deliberately does NOT include "repo:<repo>:pull_request" — that `sub`
    # value is identical for every PR run regardless of branch, author or
    # target environment, so including it here would let any pull_request
    # workflow assume a role carrying PowerUserAccess + IAM rights before any
    # review happens. PR-triggered plans use the read-only ci_plan role below
    # instead; only a push to main or the protected "prod" environment (i.e.
    # deploy.yml, which requires the environment's required reviewers) may
    # assume this role.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repository}:ref:refs/heads/main",
        "repo:${var.github_repository}:environment:prod",
      ]
    }
  }
}

resource "aws_iam_role" "ci_deploy" {
  name               = "${local.prefix}-ci-deploy"
  description        = "GitHub Actions OIDC deploy role for ${var.github_repository}"
  assume_role_policy = data.aws_iam_policy_document.ci_deploy_assume.json

  max_session_duration = 3600

  tags = {
    Name    = "${local.prefix}-ci-deploy"
    service = "platform"
    owner   = "meron"
  }
}

# Terraform runs under this role in CI and touches most services. Capstone scope:
# PowerUser for the breadth, minus IAM, plus the narrow IAM rights the stack
# genuinely needs (below). Recorded as accepted risk in docs/threat-model.md
# rather than pretended away.
resource "aws_iam_role_policy_attachment" "ci_deploy_poweruser" {
  role       = aws_iam_role.ci_deploy.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

# PowerUserAccess excludes IAM. Terraform must still manage this stack's own
# roles, so grant IAM only on resources carrying our prefix.
data "aws_iam_policy_document" "ci_deploy_iam" {
  statement {
    sid    = "ManagePrefixedRoles"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRoleTags",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:PassRole",
    ]
    resources = [
      "arn:aws:iam::${local.account_id}:role/${local.prefix}-*",
    ]
  }

  statement {
    sid       = "ReadOpenIDConnectProviders"
    effect    = "Allow"
    actions   = ["iam:GetOpenIDConnectProvider", "iam:ListOpenIDConnectProviders"]
    resources = ["*"]
  }

  # State backend access, so CI can read and write Terraform state.
  statement {
    sid    = "TerraformState"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      "arn:aws:s3:::${local.buckets.tfstate}",
      "arn:aws:s3:::${local.buckets.tfstate}/*",
    ]
  }

  statement {
    sid       = "TerraformStateLock"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = ["arn:aws:dynamodb:${var.aws_region}:${local.account_id}:table/${local.prefix}-tflock"]
  }
}

resource "aws_iam_role_policy" "ci_deploy_iam" {
  name   = "${local.prefix}-ci-deploy-iam"
  role   = aws_iam_role.ci_deploy.id
  policy = data.aws_iam_policy_document.ci_deploy_iam.json
}

# ---------------------------------------------------------------------------
# CI plan role — assumed by GitHub Actions on pull_request only
#
# `terraform plan` on a PR needs to read AWS + state to render a diff, but a
# PR from any branch must never be able to write anything. This role is
# read-only (no PowerUserAccess, no IAM write) and is the only role
# pull_request-triggered workflows (pr-checks.yml's infra-plan job) may
# assume; ci_deploy above no longer accepts the pull_request `sub` value.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ci_plan_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:pull_request"]
    }
  }
}

resource "aws_iam_role" "ci_plan" {
  name               = "${local.prefix}-ci-plan"
  description        = "Read-only GitHub Actions OIDC role for PR terraform plan on ${var.github_repository}"
  assume_role_policy = data.aws_iam_policy_document.ci_plan_assume.json

  max_session_duration = 3600 # AWS minimum; a plan run doesn't need more

  tags = {
    Name    = "${local.prefix}-ci-plan"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_iam_role_policy_attachment" "ci_plan_readonly" {
  role       = aws_iam_role.ci_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# ReadOnlyAccess covers describe/get/list everywhere but does not cover
# reading Terraform state object bytes out of a non-public bucket, which is
# still just s3:GetObject -- included in ReadOnlyAccess -- so no extra grant
# is needed here beyond the DynamoDB lock table read below (ReadOnlyAccess
# already grants dynamodb:GetItem).
data "aws_iam_policy_document" "ci_plan_state_lock" {
  statement {
    sid       = "TerraformStateLockRead"
    effect    = "Allow"
    actions   = ["dynamodb:DescribeTable"]
    resources = ["arn:aws:dynamodb:${var.aws_region}:${local.account_id}:table/${local.prefix}-tflock"]
  }
}

resource "aws_iam_role_policy" "ci_plan_state_lock" {
  name   = "${local.prefix}-ci-plan-state-lock"
  role   = aws_iam_role.ci_plan.id
  policy = data.aws_iam_policy_document.ci_plan_state_lock.json
}

# ---------------------------------------------------------------------------
# Per-service ECS roles
#
# Two roles per service, deliberately:
#   exec role  -- used by the ECS agent (pull image, write logs, read secrets)
#   task role  -- used by the application code itself
# Splitting them means application code cannot pull images or read arbitrary
# secrets just because the agent can.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Prevent the confused-deputy case: only tasks in THIS account may assume.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "task_exec" {
  for_each = toset(local.services)

  name               = "${local.prefix}-${each.key}-exec"
  description        = "ECS agent role for ${each.key}: image pull, logs, secrets"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json

  tags = {
    Name    = "${local.prefix}-${each.key}-exec"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

resource "aws_iam_role_policy_attachment" "task_exec_managed" {
  for_each = toset(local.services)

  role       = aws_iam_role.task_exec[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Secrets the agent injects as container environment. Scoped per service so the
# pos agent cannot read the daraja secret.
data "aws_iam_policy_document" "task_exec_extra" {
  for_each = toset(local.services)

  statement {
    sid       = "ReadOwnSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:${var.aws_region}:${local.account_id}:secret:${local.prefix}/${each.key}/*"]
  }

  # The ADOT sidecar's config is delivered as an SSM parameter (ecs.tf), and the
  # ECS agent -- not the task -- fetches it at container start. Without this the
  # task cannot be placed at all: ResourceInitializationError, no containers run.
  statement {
    sid       = "ReadAdotConfig"
    effect    = "Allow"
    actions   = ["ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter/${local.prefix}/adot/*"]
  }

  statement {
    sid       = "DecryptSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "task_exec_extra" {
  for_each = toset(local.services)

  name   = "${local.prefix}-${each.key}-exec-secrets"
  role   = aws_iam_role.task_exec[each.key].id
  policy = data.aws_iam_policy_document.task_exec_extra[each.key].json
}

# --- task roles (the application's own identity) ---------------------------

resource "aws_iam_role" "task" {
  for_each = toset(local.services)

  name               = "${local.prefix}-${each.key}-task"
  description        = "Application role for ${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json

  tags = {
    Name    = "${local.prefix}-${each.key}-task"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

data "aws_iam_policy_document" "task" {
  for_each = toset(local.services)

  # The ADOT sidecar ships metrics and traces under the task role.
  statement {
    sid    = "Telemetry"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "PublishMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["TillFlow/${each.key}", "ECS/ContainerInsights"]
    }
  }

  # ECS exec, for debugging a running task without SSH.
  statement {
    sid    = "ExecuteCommand"
    effect = "Allow"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task" {
  for_each = toset(local.services)

  name   = "${local.prefix}-${each.key}-task"
  role   = aws_iam_role.task[each.key].id
  policy = data.aws_iam_policy_document.task[each.key].json
}
