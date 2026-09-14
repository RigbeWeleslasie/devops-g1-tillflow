# Scar log — TillFlow / devops-g1

A running list of things that broke, what we learned, and what changed. One entry per
incident or painful surprise. Blameless. Newest first.

## Template

```
### YYYY-MM-DD — <short title>
- **Area:** <service / infra / pipeline>
- **What happened:** ...
- **Impact:** <SLO burn / gate slip / time lost>
- **Root cause:** ...
- **Fix:** <PR link>
- **Prevention:** <test / alert / doc / ADR added>
- **Owner:** <name>
```

---

### 2026-09-14 — State bucket policy denied Terraform's own state writes
- **Area:** infra (Terraform remote state)
- **What happened:** The first `terraform apply` of the VPC created 24 of 29 resources,
  then failed with `AccessDenied ... explicit deny in a resource-based policy` when
  writing state to S3. Terraform dumped `errored.tfstate` locally; the apply aborted
  before the remaining 5 resources (private route tables, S3 gateway endpoint) existed.
  Real AWS resources were created but untracked — state and reality had diverged.
- **Impact:** ~30 minutes. No data loss, no cost beyond the resources themselves. Nothing
  reached `main`; the failure was local.
- **Root cause:** Two compounding mistakes in the bucket policy from ADR 0004.
  1. `DenyUnencryptedObjectUploads` used a bare `StringNotEquals` on
     `s3:x-amz-server-side-encryption`, which denies requests that send *no* encryption
     header — even though those are still encrypted by the bucket's default SSE-KMS rule.
     The policy tested the request header, not the actual encryption outcome.
  2. The real blocker: the S3 backend configured with only `encrypt = true` sends
     `x-amz-server-side-encryption: AES256`. ADR 0004 mandates the CMK, so the policy
     correctly denied it. The backend needs `kms_key_id` to send `aws:kms` instead.
  A manual `aws s3api put-object` succeeded throughout — it sends no header — which
  masked the real cause until `TF_LOG=DEBUG` showed the `AES256` header on the wire.
- **Fix:** `kms_key_id = "alias/devops-g1-tfstate"` added to the backend block; the deny
  statement narrowed with a `Null` condition so it only rejects an explicitly *wrong*
  header. Recovered with `terraform state push errored.tfstate`, then a second apply
  completed the remaining 5 resources. `terraform plan -detailed-exitcode` now exits 0.
- **Prevention:** Encryption-enforcing bucket policies must be tested against the client
  that will actually write — the AWS CLI is not a proxy for the Terraform backend.
  `terraform plan -detailed-exitcode` is now the drift check in CI, so an untracked
  resource fails the build rather than waiting to be noticed.
- **Owner:** Meron
