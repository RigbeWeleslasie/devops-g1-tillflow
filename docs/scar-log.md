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

### 2026-09-15 — G2 Track A build: three real bugs caught by actually running the tests
- **Area:** services/pos, services/web
- **What happened:** Building POS + the web shell for G2, three genuine bugs surfaced —
  all caught because every test was actually executed (`npm test`, `npx tsx scripts/demo.ts`)
  rather than written and assumed correct:
  1. `createSale` inserted `sale_items` rows referencing `sale_id` **before** the `sales`
     row with that id existed. pg-mem correctly rejected it with a foreign-key violation —
     real Postgres would have rejected it identically; this was never a pg-mem quirk.
  2. A test asserting I1 held under a genuine concurrent race (`Promise.all` of two
     identical `POST /sales`) failed intermittently. Root cause turned out to be a
     limitation of the test harness, not the code: pg-mem does not implement true
     cross-transaction snapshot isolation/locking between concurrently-open connections,
     so two overlapping `BEGIN`-`COMMIT` blocks can both pass a pre-insert uniqueness
     check that real Postgres would serialize via row-level locking on the `UNIQUE`
     constraint. Verified pg-mem *does* enforce the same composite `PRIMARY KEY`
     correctly for ordinary sequential inserts, isolating the gap to concurrency
     specifically, not constraint enforcement in general.
  3. `services/web`'s `PosClient` sent `content-type: application/json` on every request,
     including bodyless ones like `paySale()`. Fastify's default JSON body parser rejects
     a request that declares `application/json` with an empty body (400) — this broke the
     web shell's `/sell/:id/pay` route, and would have broken the same call against the
     *real* POS service in production, not just the test fake.
- **Impact:** Caught pre-merge via `npm test`; zero runtime impact. Bug 2's test also hung
  the whole `node --test` process for its full timeout the first time, because the failed
  assertion skipped the `app.close()`/`fakePos.close()` cleanup lines below it, leaving an
  open TCP listener that kept the process alive — a separate, real test-hygiene bug on top
  of the flaky assertion itself.
- **Root cause:** (1) wrong statement order, plain and simple. (2) a mismatch between what
  the test claimed to prove (real Postgres locking semantics) and what the in-memory test
  double actually models — the code being tested is correct; the test wasn't a valid way
  to check it. (3) copying a "just always set JSON content-type" habit from a client that
  always has a body onto one endpoint that doesn't.
- **Fix:** Reordered the sale/sale_items inserts. Removed the invalid concurrency test,
  replacing it with an explicit comment documenting the pg-mem limitation and what would
  actually prove the race-safety claim (a real Postgres connection — a G3/G4 candidate,
  not something honestly available here). Made `PosClient`'s content-type conditional on
  an actual body being present. Rewrote `services/web/test/web.test.ts` to use
  `t.after()` for cleanup instead of end-of-function `await close()` calls, so a future
  assertion failure reports cleanly instead of hanging the test process.
- **Prevention:** Keep running things, not just writing them — none of these three would
  have been caught by review alone. For (2) specifically: when a test's failure mode is
  "sometimes passes, sometimes doesn't" against an in-memory test double, the default
  hypothesis should be "the double doesn't model this," not "the code is flaky" — check
  the double's own stated limitations before assuming the code under test is wrong.
- **Owner:** Rigbe

---

### 2026-09-14 — PR #4 review: the review-fixes PR had its own regressions
- **Area:** infra (S3 log delivery, bootstrap bucket policy, ci-plan IAM)
- **What happened:** The follow-up PR fixing PR #3's five findings introduced two things
  that would have made the stack *worse* than `main`, plus left the new `ci-plan` role
  unable to actually do its job:
  1. `storage.tf`'s ALB log-delivery grant used only the
     `logdelivery.elasticloadbalancing.amazonaws.com` service principal. That method isn't
     valid for ALB in `us-east-1` -- only for regions that post-date it; `us-east-1` still
     requires the legacy per-region ELB account (`127311923021`). Combined with
     `enable_alb_access_logs` now defaulting `true`, the very next `aws_lb.main` apply
     would have failed with AccessDenied.
  2. `bootstrap/main.tf`'s new `NotPrincipal` Deny on the tfstate bucket had
     `state_bucket_extra_principal_arns` defaulting to `[]`, with no automatic inclusion of
     whoever is actually running the apply. First apply would have denied `s3:*` --
     including `s3:PutBucketPolicy` -- to the operator's own session, leaving only literal
     AWS root (not an admin IAM role) able to undo it.
  3. The new `ci-plan` role (`ReadOnlyAccess` + a narrow DynamoDB statement) was missing
     `kms:Decrypt` for the state CMK (excluded from `ReadOnlyAccess`) and
     `dynamodb:PutItem`/`DeleteItem` for the state lock (`DescribeTable` alone only reads
     table metadata, not lock items) -- `terraform plan` would have failed outright on a PR.
  4. `ReadOnlyAccess` also grants `s3:GetObject` account-wide, not just on the tfstate
     bucket -- a PR from any branch could read the *contents* of every bucket in the
     account, not just infrastructure metadata.
  5. The four `storage.tf` buckets were versioned with no `force_destroy`, so
     `terraform destroy` would fail the first time any object landed in them (the very
     next session, for a bucket that exists specifically to be destroyed/rebuilt).
- **Impact:** Caught in review before merge; zero runtime impact.
- **Root cause:** Fixes were written and `terraform validate`d against syntax/type
  correctness, but validate cannot check IAM semantics (which managed-policy actions are
  actually included, whether a resource-based Deny can strand its own author) or
  region-specific AWS service behavior (ALB log delivery method). Those need either a real
  `apply` against the target region, or a second reviewer who already knows the gotcha.
- **Fix:** Added the `127311923021:root` principal to the logs bucket policy alongside the
  service-principal statements. Auto-included `data.aws_caller_identity.current.arn` in
  `local.allowed_state_principals` so the operator running an apply can never be locked out
  by that same apply (documented that this only covers the current session; a stable ARN
  via `state_bucket_extra_principal_arns` is still needed across separate SSO logins).
  Added `kms:Decrypt` (via a live `aws_kms_alias` lookup, since the CMK lives in the
  separate `bootstrap` state) and the full `GetItem`/`PutItem`/`DeleteItem` set to
  `ci-plan`. Replaced the account-wide S3 exposure with an explicit Deny scoping object
  reads to the tfstate bucket only, layered under `ReadOnlyAccess` rather than
  hand-enumerating every service's read actions. Added `force_destroy = true` to the four
  non-state buckets.
- **Prevention:** A reviewer's own review needs review, same as any other change -- this
  round came from a second pass over the fix commit, not from tooling. Region-specific AWS
  behavior (ALB log delivery, service-account IDs) is exactly the class of thing
  `terraform validate` cannot catch; a first real `apply` in the target region remains the
  actual test, still pending.
- **Owner:** Meron (review), fixes applied by Rigbe

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

### 2026-09-15 — OIDC assume-role denied: GitHub's immutable-identifier `sub`
- **Area:** infra (IAM) / CI
- **What happened:** Every GitHub Actions job using OIDC failed with
  `Could not assume role with OIDC: Not authorized to perform
  sts:AssumeRoleWithWebIdentity`. Three trust-policy rewrites -- adding
  `ref:refs/heads/*`, then a `repo:<owner>/<repo>:*` wildcard -- all failed
  identically.
- **Impact:** `infra-plan` and `audit` could not run on any PR. No effect on the
  deployed platform: the same deploy path works from a laptop via
  `./infra/scripts/deploy.sh`, which is what the workflow calls.
- **Root cause:** This GitHub org emits OIDC claims in the **immutable-identifier
  format**. The `sub` is not the documented `repo:<owner>/<repo>:<trigger>` but:

      repo:RigbeWeleslasie@198869474/devops-g1-tillflow@1362867461:pull_request

  -- the numeric account and repository ids are interpolated after each name.
  Every name-based pattern is a literal-text mismatch, so the policy could never
  match no matter how the trigger portion was written.
- **Fix:** Match on the ids: `repo:*@<owner_id>/*@<repo_id>:<trigger>`, for both
  ci-plan and ci-deploy. This is *stronger* than name matching -- a repo can be
  renamed and a freed name re-registered by someone else, but the ids never
  change and never transfer.
- **Prevention:** Do not infer an OIDC claim from documentation. The workflow now
  keeps a step that prints the token's own claims (`sub`, `aud`, `repository`,
  `ref`, `event_name`) -- claims only, never the token -- so the next mismatch is
  one run away from being obvious instead of three guesses deep. The wrong-turn
  signal was three structurally different policies failing with an identical
  error: that means the input, not the policy.
- **Owner:** Meron

### 2026-09-15 — API Gateway 503: a tls_config that AWS would not let go of
- **Area:** infra (edge: API Gateway -> VPC Link -> internal ALB)
- **What happened:** Every request through the public edge returned 503 while ECS
  tasks and ALB targets were healthy and the ALB's `RequestCount` sat at 0 --
  traffic never arrived. Roughly two hours of narrowing.
- **Impact:** The golden path could not be demonstrated end to end; the pipeline's
  post-deploy smoke test had nothing to pass against. No customer impact (pre-G2).
- **Root cause:** Two faults stacked, which is why each fix only half-worked.
  1. The VPC Link security group had an egress rule but **no ingress rule at
     all**. Declaring the SG with no inline blocks drops the default allow-all
     egress, and only egress was added back. Symptom: a silent 9s timeout with
     an empty `integrationError`.
  2. The real blocker: `tls_config { server_name_to_verify }` had been set on the
     integration while the ALB still spoke HTTPS with a self-signed certificate.
     After the listener moved to plain HTTP, Terraform planned the removal on
     every run -- and **AWS silently ignored it**. `UpdateIntegration` will not
     clear `tls_config`, so the attribute stayed, API Gateway kept trying to
     validate a certificate on a plaintext listener, and the plan never
     converged. `terraform plan` showing a change that "applies" cleanly and
     then reappears is the tell.
- **Fix:** Added the VPC Link ingress rule. Then replaced the integration **and**
  the route together (`-replace` on both) -- deleting the integration alone fails
  with a 409 because the route references it. `tls_config` is now null and the
  full path works: `/pos/health` 200 through API Gateway.
- **Prevention:** `terraform plan -detailed-exitcode` is the CI drift check; an
  attribute that will not clear shows up as a plan that never reaches exit 0
  rather than as a mystery. When a provider reports success but the plan does not
  converge, verify against the API (`get-integrations`) instead of trusting the
  apply.
- **Owner:** Meron

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
