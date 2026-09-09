# Production readiness — TillFlow / devops-g1

- **DRI:** Rigbe (Reliability + operations)
- **Status:** Checklist seeded at G0; each item links evidence as gates pass.

## Legend
☐ not started · ◐ in progress · ☑ done + evidence linked

## Architecture & data
- ☐ ADRs accepted for region, DB, S3, adapter, idempotency, sale model (`docs/adr/`)
- ☐ Service boundaries enforced (no direct Daraja from `commission`)
- ☐ Money is integer minor units everywhere; rounding rule documented once
- ☐ Per-service DB schema + least-privilege role

## Delivery
- ☐ PR checks: lint, typecheck, tests, secret scan, dep scan, IaC scan
- ☐ Docker: multi-stage, pinned base by digest, non-root, read-only rootfs
- ☐ SBOM generated + stored in `devops-g1-artifacts`
- ☐ Image scan gate (fail on fixable HIGH/CRITICAL); accepted risks logged with owner+expiry
- ☐ No `latest` tags; deploy by immutable digest; `/version` exposes SHA+digest
- ☐ `terraform plan` on PR; gated `apply` on `main` via OIDC
- ☐ CodePipeline: build → scan → ECR → ECS → post-deploy smoke → rollback
- ☐ Path filters so one service change deploys only that service

## Observability
- ☐ ADOT sidecar in every task; app exports OTLP to localhost
- ☐ JSON logs carry `trace_id`/`span_id`
- ☐ Traces show sale → payment → callback/reconciliation and scheduled commission
- ☐ 1-minute external synthetic probe (Terraform-provisioned)
- ☐ Grafana: 5m/1h/28d uptime, SLO target, budget remaining, burn rate, RED, saturation, business signals
- ☐ Per-service error budget panel

## Reliability
- ☐ SLIs/SLOs defined with numerator/denominator/window/target/exclusions (`slo-error-budgets.md`)
- ☐ Burn-rate alerts (fast/slow) wired to Slack
- ☐ Release-freeze policy on budget exhaustion
- ☐ k6: smoke/baseline/spike/soak; highest sustained RPS reported with bottleneck + headroom
- ☐ Caching before/after comparison

## Resilience / recovery
- ☐ RTO/RPO documented and **tested + timed** (`runbook.md`)
- ☐ Uncertain-payment drill (timeout → pending → reconcile → no double charge)
- ☐ Callback replay drill (one transition, one ledger effect, explanatory trace)
- ☐ Platform failure drill (cache/worker → DLQ → alert → recovery)
- ☐ Broken-release drill (smoke detect → ECS rollback)
- ☐ Restore drill (backup → safe target → RPO/RTO → provider reconcile)
- ☐ Runbook rehearsed by someone other than the author

## Security
- ☐ Threat model reviewed (`threat-model.md`)
- ☐ Secrets only in Secrets Manager; never in Git/state/logs
- ☐ Secret scanning in CI passes
- ☐ IAM least privilege (CI role scoped to repo+branch; task roles per service)
- ☐ S3: versioning + KMS + block-public + lifecycle on all buckets
- ☐ Log redaction of `Authorization`, `password`, MSISDN

## Ops hygiene
- ☐ One-command bootstrap/deploy/destroy
- ☐ Cost estimate in README
- ☐ Cleanup / destroy-rebuild verified
- ☐ Every resource tagged: `group owner environment service managed-by=terraform capstone=tillflow`
