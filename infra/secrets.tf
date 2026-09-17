# secrets.tf — Secrets Manager entries.
#
# DRI: Meron (Platform + delivery).
#
# Terraform creates the secret CONTAINERS and the access grants; it never holds a
# real value. Daraja sandbox keys and the Slack webhook are written out-of-band
# (`aws secretsmanager put-secret-value`, documented in docs/runbook.md) so no
# credential ever reaches Git, a plan file, or Terraform state.
#
# Naming follows the brief: devops-g1/daraja, devops-g1/slack-webhook,
# devops-g1/db -- plus per-service paths matching iam.tf's grant of
# `secretsmanager:GetSecretValue` on `${prefix}/${service}/*`.

# The DB password is the one value Terraform does generate, because RDS needs it
# at create time. It is never printed: `random_password` is marked sensitive and
# the secret version is the only place it lands.
resource "random_password" "db_master" {
  length  = 32
  special = true
  # RDS rejects these in a master password.
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_kms_key" "secrets" {
  description             = "${local.prefix} Secrets Manager encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 7

  tags = {
    Name    = "${local.prefix}-secrets"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${local.prefix}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

# ---------------------------------------------------------------------------
# devops-g1/db — RDS master credentials
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "db" {
  name        = "${local.prefix}/db"
  description = "RDS PostgreSQL master credentials (ADR 0003)"
  kms_key_id  = aws_kms_key.secrets.arn

  # A capstone destroys and rebuilds; the default 30-day recovery window would
  # make the name unavailable on the next apply.
  recovery_window_in_days = 0

  tags = {
    Name    = "${local.prefix}-db"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = var.db_master_username
    password = random_password.db_master.result
    engine   = "postgres"
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    dbname   = var.db_name
    # Assembled here so the migration task can inject one secret key as
    # ADMIN_DATABASE_URL rather than composing a URL from five fields in a shell.
    # sslmode=require: ADR 0003 sets rds.force_ssl=1, so a plain connection is
    # refused by the server anyway -- being explicit makes that intentional.
    database_url = format(
      "postgresql://%s:%s@%s:%d/%s?sslmode=require",
      var.db_master_username,
      urlencode(random_password.db_master.result),
      aws_db_instance.main.address,
      aws_db_instance.main.port,
      var.db_name,
    )
  })
}

# ---------------------------------------------------------------------------
# devops-g1/daraja — M-Pesa sandbox credentials (value written out-of-band)
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "daraja" {
  name        = "${local.prefix}/daraja"
  description = "Daraja 3.0 SANDBOX credentials. Never production. Set out-of-band."
  kms_key_id  = aws_kms_key.secrets.arn

  recovery_window_in_days = 0

  tags = {
    Name    = "${local.prefix}-daraja"
    service = "payments"
    owner   = local.service_owner["payments"]
  }
}

# Placeholder only, so the secret exists and ECS can resolve it. The real values
# are put out-of-band; `ignore_changes` stops Terraform reverting them.
resource "aws_secretsmanager_secret_version" "daraja" {
  secret_id = aws_secretsmanager_secret.daraja.id
  secret_string = jsonencode({
    consumer_key        = "PLACEHOLDER_SET_OUT_OF_BAND"
    consumer_secret     = "PLACEHOLDER_SET_OUT_OF_BAND"
    shortcode           = "174379" # Daraja sandbox test till
    passkey             = "PLACEHOLDER_SET_OUT_OF_BAND"
    base_url            = "https://sandbox.safaricom.co.ke"
    initiator_name      = "PLACEHOLDER_SET_OUT_OF_BAND"
    security_credential = "PLACEHOLDER_SET_OUT_OF_BAND"
    # B2C disburses from a separate shortcode to the till that collects.
    b2c_shortcode = "PLACEHOLDER_SET_OUT_OF_BAND"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# devops-g1/slack-webhook — alert destination (value written out-of-band)
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "slack_webhook" {
  name        = "${local.prefix}/slack-webhook"
  description = "Slack incoming webhook for alerts. Never in Git, state or build logs."
  kms_key_id  = aws_kms_key.secrets.arn

  recovery_window_in_days = 0

  tags = {
    Name    = "${local.prefix}-slack-webhook"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_secretsmanager_secret_version" "slack_webhook" {
  secret_id     = aws_secretsmanager_secret.slack_webhook.id
  secret_string = jsonencode({ webhook_url = "PLACEHOLDER_SET_OUT_OF_BAND" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# devops-g1/service-token — shared bearer token for service-to-service calls
#
# Guards the routes reachable through API Gateway that should only ever be called
# by another service: POS `/internal/daily-close`, Payments `/charges`,
# `/payouts` and `/admin/*` (threat-model.md §3.2, and the G2 authz header).
#
# Terraform generates this one, like the DB master password: all three services
# must present the SAME value, so it cannot be set per-service out-of-band
# without them drifting apart. It never leaves state and Secrets Manager.
# ---------------------------------------------------------------------------

resource "random_password" "service_token" {
  length = 48
  # Alphanumeric only: the value travels in an `x-service-token` HTTP header,
  # where punctuation invites quoting and encoding bugs for no added entropy --
  # 48 alphanumerics is ~285 bits, far past the 16-char minimum the services
  # enforce at boot.
  special = false
}

resource "aws_secretsmanager_secret" "service_token" {
  name        = "${local.prefix}/service-token"
  description = "Shared bearer token for service-to-service calls (POS /internal/*, Payments /charges, /payouts, /admin/*)"
  kms_key_id  = aws_kms_key.secrets.arn

  recovery_window_in_days = 0

  tags = {
    Name    = "${local.prefix}-service-token"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_secretsmanager_secret_version" "service_token" {
  secret_id     = aws_secretsmanager_secret.service_token.id
  secret_string = jsonencode({ token = random_password.service_token.result })

  # No ignore_changes: Terraform owns this value. Rotating it means one apply
  # plus a redeploy of all three services -- they must change together, since a
  # half-rotated fleet fails every internal call with 401.
}

# ---------------------------------------------------------------------------
# devops-g1/jwt — POS signs attendant/owner sessions with this
#
# Terraform-generated like the service token: it is an internal signing key with
# no external counterparty, so there is nothing to coordinate out-of-band.
# ---------------------------------------------------------------------------

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "jwt" {
  name        = "${local.prefix}/jwt"
  description = "JWT signing secret for POS browser sessions"
  kms_key_id  = aws_kms_key.secrets.arn

  recovery_window_in_days = 0

  tags = {
    Name    = "${local.prefix}-jwt"
    service = "pos"
    owner   = local.service_owner["pos"]
  }
}

resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id     = aws_secretsmanager_secret.jwt.id
  secret_string = jsonencode({ secret = random_password.jwt.result })
}

# ---------------------------------------------------------------------------
# Per-service secrets
#
# iam.tf grants each exec role GetSecretValue on `${prefix}/${service}/*`.
# Creating the path here means those grants point at something real rather than
# dangling (G1 review P0-2).
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "service_db" {
  for_each = toset(local.services)

  name        = "${local.prefix}/${each.key}/db"
  description = "Least-privilege DB credentials for ${each.key} (ADR 0003: one role per schema)"
  kms_key_id  = aws_kms_key.secrets.arn

  recovery_window_in_days = 0

  tags = {
    Name    = "${local.prefix}-${each.key}-db"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# The per-service roles and their passwords are created by the migration job in
# G2 (ADR 0003). Until then the entry carries connection details only, so the
# grant resolves and the shape is fixed.
#
# Connection details and the password are split into two secrets on purpose.
# Holding both in one entry forces a choice between two broken options:
# `ignore_changes` freezes the endpoint, so after an instance replacement every
# service keeps dialling a host that no longer exists and no plan shows it; and
# without it, Terraform overwrites the migration job's password on every apply.
# Splitting them lets Terraform own the endpoint (which it knows) and the
# migration job own the credential (which it knows).
resource "aws_secretsmanager_secret_version" "service_db" {
  for_each = toset(local.services)

  secret_id = aws_secretsmanager_secret.service_db[each.key].id
  secret_string = jsonencode({
    host   = aws_db_instance.main.address
    port   = aws_db_instance.main.port
    dbname = var.db_name
    # commission shares the payments schema: the payout ledger is an integrity
    # concern owned by Payments (docs/architecture.md §3).
    schema   = each.key == "commission" ? "payments" : each.key
    username = "${local.prefix}-${each.key == "commission" ? "payments" : each.key}-app"
    # No password here -- see aws_secretsmanager_secret.service_db_password.
  })

  # No ignore_changes: the endpoint must track the instance.
}

# The credential itself, written by the G2 migration job and never by Terraform.
resource "aws_secretsmanager_secret" "service_db_password" {
  for_each = toset(local.services)

  name        = "${local.prefix}/${each.key}/db-password"
  description = "Runtime DB password for ${each.key}; set by the migration job (ADR 0003)"
  kms_key_id  = aws_kms_key.secrets.arn

  recovery_window_in_days = 0

  tags = {
    Name    = "${local.prefix}-${each.key}-db-password"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

resource "aws_secretsmanager_secret_version" "service_db_password" {
  for_each = toset(local.services)

  secret_id = aws_secretsmanager_secret.service_db_password[each.key].id

  # `database_url` as well as `password`: the service reads one value rather
  # than composing a URL from five, and ECS can inject a single secret key. The
  # migration job (`--write-secret`) overwrites both once it has created the
  # role -- `ignore_changes` below is what lets it.
  secret_string = jsonencode({
    password     = "PLACEHOLDER_SET_BY_MIGRATION_JOB"
    database_url = "PLACEHOLDER_SET_BY_MIGRATION_JOB"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
