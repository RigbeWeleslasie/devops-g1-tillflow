# infra/bootstrap — one-time remote-state backing store.
#
# Run with LOCAL state (no backend block here). Creates the S3 state bucket, the
# DynamoDB lock table, and a KMS key for state encryption. After apply, uncomment
# the backend block in ../backend.tf and `terraform init -migrate-state` the main stack.
#
# Per ADR 0004 (object storage). DRI: Meron (Platform + delivery).

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.aws_region
  # Guard: refuse to run against any account but the capstone one. The workstation's
  # `default` profile points at an unrelated account -- this makes a mistake fail
  # before it creates anything. Pass the profile explicitly via AWS_PROFILE.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      group        = var.group
      owner        = "meron"
      environment  = var.environment
      service      = "platform"
      "managed-by" = "terraform"
      capstone     = "tillflow"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  state_bucket = "${var.name_prefix}-tfstate-${local.account_id}"
  lock_table   = "${var.name_prefix}-tflock"
}

# ---------------------------------------------------------------------------
# KMS key for Terraform state encryption (SSE-KMS, ADR 0004)
# ---------------------------------------------------------------------------

resource "aws_kms_key" "state" {
  description             = "devops-g1 TillFlow Terraform state encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 7

  tags = {
    Name = "${var.name_prefix}-tfstate"
  }
}

resource "aws_kms_alias" "state" {
  name          = "alias/${var.name_prefix}-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

# ---------------------------------------------------------------------------
# State bucket — versioned, KMS-encrypted, private, TLS-only (ADR 0004)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "tfstate" {
  bucket = local.state_bucket

  # State is the one bucket we never want destroyed by accident. The destroy
  # runbook (G5) removes this protection deliberately as a documented step.
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name = local.state_bucket
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ACLs disabled — access via IAM only (ADR 0004).
resource "aws_s3_bucket_ownership_controls" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Keep noncurrent state versions 90 days, then delete (ADR 0004).
resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    id     = "expire-noncurrent-state"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Require TLS and require the CMK on writes (ADR 0004).
resource "aws_s3_bucket_policy" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  policy = data.aws_iam_policy_document.tfstate.json

  # The public-access block must land first or the policy write can be rejected.
  depends_on = [aws_s3_bucket_public_access_block.tfstate]
}

data "aws_iam_policy_document" "tfstate" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.tfstate.arn,
      "${aws_s3_bucket.tfstate.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Deny only uploads that explicitly ask for the WRONG encryption.
  #
  # A plain `StringNotEquals` here also denies requests that send no encryption
  # header at all -- which is what the Terraform S3 backend does. Those uploads
  # are still encrypted, by the bucket's default SSE-KMS rule above, so denying
  # them buys nothing and breaks state writes. `Null = false` scopes the deny to
  # requests that set the header, letting header-less ones take the default.
  statement {
    sid    = "DenyWrongEncryptionHeader"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.tfstate.arn}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }

    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["false"]
    }
  }
}

# ---------------------------------------------------------------------------
# DynamoDB state lock table (ADR 0004)
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "tflock" {
  name         = local.lock_table
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = local.lock_table
  }
}

# ---------------------------------------------------------------------------
# Outputs — feed ../backend.tf
# ---------------------------------------------------------------------------

output "state_bucket" {
  description = "S3 bucket holding the main stack's Terraform state."
  value       = aws_s3_bucket.tfstate.id
}

output "lock_table" {
  description = "DynamoDB table used for state locking."
  value       = aws_dynamodb_table.tflock.name
}

output "state_kms_key_arn" {
  description = "CMK encrypting the state bucket."
  value       = aws_kms_key.state.arn
}

output "backend_config" {
  description = "Paste into ../backend.tf (or use -backend-config)."
  value       = <<-EOT
    bucket         = "${aws_s3_bucket.tfstate.id}"
    key            = "tillflow/main/terraform.tfstate"
    region         = "${var.aws_region}"
    dynamodb_table = "${aws_dynamodb_table.tflock.name}"
    encrypt        = true
  EOT
}
