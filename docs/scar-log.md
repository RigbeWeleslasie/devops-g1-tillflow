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

### 2026-09-14 — PR #3 review: OIDC trust policy over-scoped, three landmines in the golden path
- **Area:** infra (IAM/OIDC), services/_shared (Docker), infra (S3/edge)
- **What happened:** Code review of the G1 golden-path PR (VPC, ECS, ALB/API GW, IAM OIDC,
  state backend, audit script, shared Docker base) surfaced five issues before merge:
  1. `devops-g1-ci-deploy`'s OIDC trust policy accepted the `pull_request` `sub` claim
     alongside `ref:refs/heads/main` and `environment:prod`. That claim is identical for
     *every* PR run regardless of branch or author, so any PR could have assumed a role
     carrying PowerUserAccess + IAM rights with no review gate in front of it.
  2. The shared reference Dockerfile's `COPY package*.json ./` and
     `COPY --from=deps /app/node_modules* ...` used wildcard globs that matched zero files
     (no `package.json` existed yet) — BuildKit fails a `COPY` whose glob matches nothing,
     so the golden-path image could not actually be built.
  3. `docs/threat-model.md` claimed the tfstate bucket policy "restricts access to CI +
     platform roles," but the policy only denied insecure transport / wrong KMS key — no
     statement restricted *who* could act on the bucket at all.
  4. `edge.tf`'s ALB `access_logs` block pointed at `local.buckets.logs`, a bucket no `.tf`
     file created — safe only because `enable_alb_access_logs` defaulted off; flipping it
     on would have failed apply with nothing to deliver to, or nowhere for `terraform plan`
     to even reference.
  5. The ALB->service security-group ingress rule was created for `commission` too, even
     though the worker has no target group/listener by design — open, unused ingress.
- **Impact:** Caught pre-merge; zero runtime impact. ~1 hour of fix + validate time.
- **Root cause:** (1) the OIDC `sub` condition list was written to cover "any GitHub Actions
  run" rather than "only a reviewed deploy," conflating plan and apply trust. (2)/(4) both
  are the same shape: code referenced an artifact (a file glob, an S3 bucket) that didn't
  exist yet, gated by something that made it *look* safe (an `if [ -f ... ]` guard, a
  default-off variable) without actually being safe once that gate changed. (3) a doc
  described the intended end state before the implementation caught up.
- **Fix:** Added a separate least-privilege `devops-g1-ci-plan` role (ReadOnlyAccess, no
  IAM/apply rights) for PR-triggered `terraform plan`; removed `pull_request` from
  `ci-deploy`'s trust policy entirely. Fixed the Dockerfile to COPY a required `package.json`
  (now committed) plus an optional lockfile as separate sources, and to `mkdir -p
  node_modules` so the runtime-stage COPY never depends on a glob. Added `infra/storage.tf`
  (the `artifacts`/`backups`/`evidence`/`logs` buckets from ADR 0004, actually implemented —
  not just named in `locals.buckets`), pointed `edge.tf` at the real bucket resource with an
  explicit `depends_on`, and flipped `enable_alb_access_logs` on by default now that it's
  backed by something real. Added an explicit `Deny` + `NotPrincipal` statement to the
  tfstate bucket policy so `docs/threat-model.md`'s claim is now true, not aspirational.
  Scoped the ALB ingress rule to exclude `commission`.
- **Prevention:** `terraform validate` (and `fmt -check`) now run locally before every
  infra PR, not just in CI — caught an unrelated `max_session_duration` range error on the
  new role during this same pass. Reviewing "is this default safe *if the gate flips*,"
  not just "is this default safe today," for every variable that gates an as-yet-unbuilt
  resource.
- **Owner:** Meron (fixes applied by Rigbe per PR #3 review; Meron to confirm on re-review)

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
