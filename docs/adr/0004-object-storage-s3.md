# ADR 0004 — Object storage: one S3 bucket per purpose

- **Status:** Accepted
- **Date:** 2026-09-09
- **DRI:** Meron (Platform + delivery)
- **Required proof:** this ADR + bucket policies / `terraform plan`

## Context

The brief requires one bucket per purpose, and for each: versioning, KMS encryption,
block-public-access, and lifecycle/retention. The Terraform state bucket additionally
needs a DynamoDB lock table. S3 names are globally unique, so we append the account ID.

## Decision

Five buckets, all in `us-east-1`, all private, all with a `capstone=tillflow` tag set.

| Bucket (`<ACCT>` = AWS account id) | Purpose | Versioning | Encryption | Public access | Lifecycle / retention |
| --------------------------------- | ------- | ---------- | ---------- | ------------- | --------------------- |
| `devops-g1-tfstate-<ACCT>`   | Terraform remote state | **On** (state history / recovery) | SSE-KMS (CMK) | Block all | Keep noncurrent 90 days, then delete. No expiration of current. |
| `devops-g1-artifacts-<ACCT>` | Pipeline/build artifacts, SBOMs | On | SSE-KMS (CMK) | Block all | Current → expire 90 days; noncurrent 7 days; abort incomplete MPU 7 days. |
| `devops-g1-logs-<ACCT>`      | ALB access logs, pipeline logs | On | SSE-S3 (AES256 — ALB log delivery constraint) | Block all | Transition to IA 30 days; expire 365 days. |
| `devops-g1-backups-<ACCT>`   | DB exports, pre-drill snapshots, config backups | On | SSE-KMS (CMK) | Block all | Noncurrent 30 days; current expire 180 days. Object Lock (governance) optional. |
| `devops-g1-evidence-<ACCT>`  | Gate evidence: k6 JSON, traces, Grafana exports, scan reports | On | SSE-KMS (CMK) | Block all | No expiration until after G5; then destroy with the stack. |

Common to every bucket:
- `aws_s3_bucket_public_access_block` with all four flags `true`.
- Bucket policy: `aws:SecureTransport` required; deny non-KMS `PutObject` where CMK applies.
- Ownership controls: `BucketOwnerEnforced` (ACLs disabled).
- Access via IAM roles only (CI deploy role, pipeline role, task roles) — least privilege
  per bucket.

**State bucket extras:**
- DynamoDB table `devops-g1-tflock` — `PAY_PER_REQUEST`, `LockID` (string) hash key,
  point-in-time recovery on.
- The state bucket + lock table are created by a one-time bootstrap (`make bootstrap` /
  `infra/bootstrap/`) with local state, then everything else uses the S3 backend.

## Consequences

- `infra/bootstrap/` is a tiny separate root module (state bucket + lock table + KMS key
  for state). Committed with its own README so a fresh clone can `destroy/rebuild`.
- One CMK per sensitive bucket family (or one shared `devops-g1-s3` CMK) — decided in the
  Terraform PR; key policy grants only the relevant roles.
- ALB logs use SSE-S3 because the ALB log-delivery principal cannot use a CMK without
  extra key-policy work not worth it for logs.
- All buckets are torn down by `make destroy` except we snapshot `evidence` contents
  locally / to the graders before destroy in G5.
