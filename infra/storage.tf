# storage.tf — the four non-state S3 buckets from ADR 0004 (tfstate itself is
# created by infra/bootstrap, before this stack's backend exists).
#
# DRI: Meron (Platform + delivery). Added to close the gap flagged in PR #3
# review: edge.tf's ALB access_logs block referenced local.buckets.logs before
# any .tf file created it, so flipping var.enable_alb_access_logs on would
# have failed apply with no bucket to deliver to.

# ---------------------------------------------------------------------------
# Shared CMK for the SSE-KMS buckets (ADR 0004: "one CMK per sensitive bucket
# family, or one shared devops-g1-s3 CMK" -- we take the shared key; three
# buckets don't warrant three keys for a capstone-scoped account). The logs
# bucket is deliberately NOT under this key -- see aws_s3_bucket.logs below.
# ---------------------------------------------------------------------------

resource "aws_kms_key" "s3" {
  description             = "devops-g1 TillFlow S3 (artifacts/backups/evidence) encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 7

  tags = {
    Name    = "${local.prefix}-s3"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_kms_alias" "s3" {
  name          = "alias/${local.prefix}-s3"
  target_key_id = aws_kms_key.s3.key_id
}

# ---------------------------------------------------------------------------
# artifacts / backups / evidence -- same shape, different lifecycle per ADR 0004
# ---------------------------------------------------------------------------

locals {
  kms_buckets = {
    artifacts = {
      current_expire_days    = 90
      noncurrent_expire_days = 7
    }
    backups = {
      current_expire_days    = 180
      noncurrent_expire_days = 30
    }
    evidence = {
      # "No expiration until after G5; then destroy with the stack" -- no
      # lifecycle expiration rule; the objects go away with `make destroy`.
      current_expire_days    = null
      noncurrent_expire_days = null
    }
  }
}

resource "aws_s3_bucket" "kms" {
  for_each = local.kms_buckets

  bucket = local.buckets[each.key]

  tags = {
    Name    = local.buckets[each.key]
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_s3_bucket_versioning" "kms" {
  for_each = local.kms_buckets

  bucket = aws_s3_bucket.kms[each.key].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "kms" {
  for_each = local.kms_buckets

  bucket = aws_s3_bucket.kms[each.key].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "kms" {
  for_each = local.kms_buckets

  bucket                  = aws_s3_bucket.kms[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "kms" {
  for_each = local.kms_buckets

  bucket = aws_s3_bucket.kms[each.key].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "kms" {
  for_each = local.kms_buckets

  bucket = aws_s3_bucket.kms[each.key].id

  rule {
    id     = "expire-${each.key}"
    status = "Enabled"

    filter {}

    dynamic "expiration" {
      for_each = each.value.current_expire_days == null ? [] : [each.value.current_expire_days]
      content {
        days = expiration.value
      }
    }

    dynamic "noncurrent_version_expiration" {
      for_each = each.value.noncurrent_expire_days == null ? [] : [each.value.noncurrent_expire_days]
      content {
        noncurrent_days = noncurrent_version_expiration.value
      }
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# TLS-only + this-CMK-only, same shape as infra/bootstrap's tfstate policy.
data "aws_iam_policy_document" "kms" {
  for_each = local.kms_buckets

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.kms[each.key].arn,
      "${aws_s3_bucket.kms[each.key].arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Same Null guard as infra/bootstrap/main.tf: only deny requests that
  # explicitly name the wrong key/algorithm, not header-less ones, which
  # still land under the bucket's own default SSE-KMS rule above.
  statement {
    sid    = "DenyWrongKmsKey"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.kms[each.key].arn}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.s3.arn]
    }

    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "kms" {
  for_each = local.kms_buckets

  bucket     = aws_s3_bucket.kms[each.key].id
  policy     = data.aws_iam_policy_document.kms[each.key].json
  depends_on = [aws_s3_bucket_public_access_block.kms]
}

# ---------------------------------------------------------------------------
# logs -- SSE-S3, not KMS (ADR 0004: the ELB log-delivery service can't write
# under a customer-managed key without extra key-policy work not worth it for
# logs). This is what edge.tf's ALB access_logs block, and the pipeline logs
# that land here later, actually deliver to.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "logs" {
  bucket = local.buckets.logs

  tags = {
    Name    = local.buckets.logs
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    # ELB log delivery still writes via ACL under the hood even on a
    # bucket-owner-enforced bucket, granted through the delivery service's
    # own bucket policy (below) rather than an ACL grant -- BucketOwnerEnforced
    # is safe to keep here, matching the other buckets.
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "transition-and-expire-logs"
    status = "Enabled"

    filter {}

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    expiration {
      days = 365
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ELB access-log delivery grant (current AWS-recommended form: the regional
# log-delivery service principal, not a hardcoded per-region ELB account id)
# plus the same TLS-only baseline the other buckets carry.
data "aws_iam_policy_document" "logs" {
  statement {
    sid    = "AWSLogDeliveryWrite"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/alb/AWSLogs/${local.account_id}/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  statement {
    sid    = "AWSLogDeliveryAclCheck"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }

    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.logs.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.logs.arn,
      "${aws_s3_bucket.logs.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket     = aws_s3_bucket.logs.id
  policy     = data.aws_iam_policy_document.logs.json
  depends_on = [aws_s3_bucket_public_access_block.logs]
}
