# iam.tf — CI deploy role (OIDC) and per-service ECS roles.
#
# DRI: Meron (Platform + delivery).
#
# No long-lived AWS keys exist anywhere in this project. GitHub Actions federates
# via OIDC and assumes devops-g1-ci-deploy; the trust policy is scoped to this
# repository so another repo presenting a valid GitHub token still cannot assume it.

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

# Adopt only -- never create.
#
# The provider is account-wide and already exists on this shared cohort account
# (another group created it). A create path would call
# iam:CreateOpenIDConnectProvider, which the permission set denies, so the only
# thing that branch could ever produce is a confusing failure. Removing it makes
# the deny path unreachable rather than merely defaulted-off.
locals {
  github_oidc_arn = data.aws_iam_openid_connect_provider.github.arn
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
    #
    # Matched by immutable IDs, for the same reason as ci_plan below: this org
    # emits `repo:<owner>@<owner_id>/<repo>@<repo_id>:<trigger>`, so a name-only
    # pattern matches nothing at all. The trailing trigger is still pinned
    # exactly -- that is the part doing the security work here.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:*@${var.github_owner_id}/*@${var.github_repository_id}:ref:refs/heads/main",
        "repo:*@${var.github_owner_id}/*@${var.github_repository_id}:environment:prod",
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

    # This repository, matched by IMMUTABLE IDs.
    #
    # The org has GitHub's immutable-identifier format enabled, so the `sub`
    # claim is not `repo:<owner>/<repo>:...` but:
    #
    #   repo:RigbeWeleslasie@198869474/devops-g1-tillflow@1362867461:pull_request
    #
    # -- the numeric account and repository IDs are interpolated after each name.
    # A name-only pattern cannot match that text, which is why every trust policy
    # written against the documented shape failed with "Not authorized to perform
    # sts:AssumeRoleWithWebIdentity" (see docs/scar-log.md).
    #
    # Matching on the IDs is stronger than matching on names: a repo can be
    # renamed, and a freed-up name can be claimed by someone else, but these IDs
    # never change and never transfer. The wildcards cover the name halves (which
    # may change) and the trailing trigger.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:*@${var.github_owner_id}/*@${var.github_repository_id}:*",
      ]
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

# ReadOnlyAccess grants s3:GetObject account-wide -- not just on the tfstate
# bucket, but on every bucket in the account, including artifacts/backups/
# evidence and anything belonging to other groups sharing this cohort
# account. A pull_request run from any branch could otherwise read object
# CONTENTS anywhere, not just infrastructure metadata. Deny object reads
# everywhere except the one bucket plan genuinely needs to read from.
data "aws_iam_policy_document" "ci_plan_deny_object_reads" {
  statement {
    sid    = "DenyObjectReadsExceptState"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectAttributes",
      "s3:GetObjectTagging",
    ]
    not_resources = [
      "arn:aws:s3:::${local.buckets.tfstate}/*",
    ]
  }
}

resource "aws_iam_role_policy" "ci_plan_deny_object_reads" {
  name   = "${local.prefix}-ci-plan-deny-object-reads"
  role   = aws_iam_role.ci_plan.id
  policy = data.aws_iam_policy_document.ci_plan_deny_object_reads.json
}

# The state bucket's CMK is created by infra/bootstrap -- a separate root
# module with its own state, so it isn't an `aws_kms_key` resource here. A
# live alias lookup is the correct way to reference it from this stack
# (not cross-state referencing, which would couple two independent applies).
data "aws_kms_alias" "state" {
  name = "alias/${local.prefix}-tfstate"
}

# ReadOnlyAccess does not cover kms:Decrypt (KMS crypto operations are
# deliberately excluded from the managed policy, unlike Describe/Get/List) or
# DynamoDB writes -- and the S3 backend needs both to actually run `plan`:
# kms:Decrypt to read the SSE-KMS-encrypted state object, and GetItem/
# PutItem/DeleteItem (not just DescribeTable) to take and release the state
# lock, since the backend locks even for a read-only plan unless `-lock=false`.
data "aws_iam_policy_document" "ci_plan_state_access" {
  statement {
    sid       = "TerraformStateDecrypt"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.state.target_key_arn]
  }

  statement {
    sid       = "TerraformStateLock"
    effect    = "Allow"
    actions   = ["dynamodb:DescribeTable", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = ["arn:aws:dynamodb:${var.aws_region}:${local.account_id}:table/${local.prefix}-tflock"]
  }
}

resource "aws_iam_role_policy" "ci_plan_state_access" {
  name   = "${local.prefix}-ci-plan-state-access"
  role   = aws_iam_role.ci_plan.id
  policy = data.aws_iam_policy_document.ci_plan_state_access.json
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

  # The shared service token is the one secret that is deliberately NOT
  # per-service: POS, Payments and Commission must present the same value to
  # each other, so a per-service path would guarantee drift. `web` is excluded
  # -- it is a browser-facing shell and never makes an authenticated
  # service-to-service call.
  #
  # Secrets Manager appends a random 6-character suffix to every ARN, hence the
  # trailing wildcard; without it the grant matches nothing and the task fails
  # at boot with AccessDenied rather than anything that names the cause.
  dynamic "statement" {
    for_each = each.key == "web" ? [] : [1]
    content {
      sid       = "ReadServiceToken"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = ["arn:aws:secretsmanager:${var.aws_region}:${local.account_id}:secret:${local.prefix}/service-token-*"]
    }
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
