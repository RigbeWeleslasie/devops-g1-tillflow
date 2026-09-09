# Ownership — TillFlow / devops-g1

> Rule: exactly **one** directly responsible engineer (DRI) per primary area.
> "Everyone owns it" is not accepted. Ownership is shown through this document and
> [`CODEOWNERS`](../CODEOWNERS), not through resource names.

## Team

| # | Member | GitHub handle       | Primary area              | Cross-review of        |
| - | ------ | ------------------- | ------------------------- | ---------------------- |
| 1 | Rigbe  | `@RigbeWeleslasie`  | Product + POS             | Payments + integrity   |
| 2 | Nebyat | `@nebyathhailu`     | Payments + integrity      | Platform + delivery    |
| 3 | Meron  | `@meronkhasay`      | Platform + delivery       | Product + POS          |
| 4 | Rigbe  | `@RigbeWeleslasie`  | Reliability + operations  | Payments + integrity   |

Rigbe holds two primary areas (Product+POS and Reliability+operations) — permitted by
the rule "every member owns at least one area". Every area has a single DRI and every
member cross-reviews at least one other area.

> Rigbe's handle is taken from the git remote URL (`RigbeWeleslasie`). All three members
> must be added as repo collaborators for the `CODEOWNERS` entries to resolve as required
> reviewers under branch protection.

## Area 1 — Product + POS · DRI: Rigbe

**Owns and decides:** tenant model, frontend flow, POS API, sale state machine, request
contracts and validation boundaries.

**Key decisions (ADRs):**
- Sale idempotency key strategy — [`adr/0007-sale-idempotency.md`](adr/0007-sale-idempotency.md)
- Tenant isolation model (row-level `tenant_id` + scoped DB role)
- Money represented as integer minor units everywhere (no floats)

**Paths owned:** `services/web/`, `services/pos/`, `docs/adr/0007-*`

**Minimum personal proof:** ADR + end-to-end sale demo (sale created → paid → visible),
plus state/idempotency tests showing a duplicate POST does not create a second sale.

## Area 2 — Payments + integrity · DRI: Nebyat

**Owns and decides:** Daraja auth, STK Push, callbacks, transaction query, B2C,
reconciliation, payment/payout state machines, idempotency, and replay safety. Also owns
the **Commission worker** (`services/commission/`) because its payout ledger and
replay-safety are integrity concerns.

**Key decisions (ADRs):**
- M-Pesa adapter interface + deterministic fake — [`adr/0005-mpesa-fake-adapter.md`](adr/0005-mpesa-fake-adapter.md)
- Idempotency & replay strategy (callback dedupe, payout ledger uniqueness) — [`adr/0006-idempotency-and-replay.md`](adr/0006-idempotency-and-replay.md)
- "A timeout is not a decline" — pending state + query/reconcile flow

**Paths owned:** `services/payments/`, `services/commission/`, `docs/adr/0005-*`, `docs/adr/0006-*`

**Minimum personal proof:** invariant tests (one legal state transition per callback, one
ledger effect, zero double-pay under replay) + a distributed trace showing
sale → STK → callback → reconciliation.

## Area 3 — Platform + delivery · DRI: Meron

**Owns and decides:** Terraform (all AWS resources, pipelines, alarms, dashboards), IAM,
ECS Fargate services, RDS, ElastiCache, SQS/DLQ, EventBridge, S3, GitHub Actions,
CodePipeline, and all security scans.

**Key decisions (ADRs):**
- AWS region — [`adr/0002-aws-region.md`](adr/0002-aws-region.md)
- Database (RDS PostgreSQL) sizing, Multi-AZ, per-service schemas/roles, backups/RPO — [`adr/0003-database-rds-postgresql.md`](adr/0003-database-rds-postgresql.md)
- Object storage (S3 buckets, one per purpose) — [`adr/0004-object-storage-s3.md`](adr/0004-object-storage-s3.md)

**Paths owned:** `infra/`, `.github/`, `services/_shared/` (co-owned with Nebyat for the
adapter interface), `docs/adr/0002-*`, `0003-*`, `0004-*`

**Minimum personal proof:** `terraform plan` + gated `apply`, naming/tag audit output,
and one pipeline release deploying a single service by SHA/digest.

## Area 4 — Reliability + operations · DRI: Rigbe

**Owns and decides:** SLIs/SLOs, error budgets and burn-rate policy, ADOT/Grafana
telemetry design, k6 capacity model, alerting (Slack contract), recovery experiments
(RTO/RPO, rollback vs roll-forward, replay ownership, restore), and the runbook.

**Key decisions:**
- SLI/SLO definitions + exclusions — [`slo-error-budgets.md`](slo-error-budgets.md)
- Budget policy (fast/slow burn, release freeze) — [`slo-error-budgets.md`](slo-error-budgets.md)
- Alerting & recovery — [`runbook.md`](runbook.md)

**Paths owned:** `k6/`, `docs/slo-error-budgets.md`, `docs/runbook.md`,
`docs/production-readiness.md`, `evidence/reliability-ops/`

**Minimum personal proof:** Grafana dashboard export (uptime/SLO/budget/burn/RED/
saturation/business), k6 JSON + analysis with the highest sustained RPS, and a timed
game-day drill with a firing + recovery Slack alert.

## Critical decisions — DRI ledger

Every critical decision has a named DRI. If any row loses its DRI, G0 is blocked.

| Decision                          | DRI    | Proof artifact                         |
| --------------------------------- | ------ | ------------------------------------- |
| AWS region                        | Meron  | `adr/0002-aws-region.md` + plan        |
| Database engine/size/Multi-AZ/RPO | Meron  | `adr/0003-*` + `terraform plan`        |
| S3 buckets (per purpose)          | Meron  | `adr/0004-*` + bucket policy           |
| M-Pesa adapter + fake             | Nebyat | `adr/0005-*` + contract test           |
| Idempotency & replay              | Nebyat | `adr/0006-*` + invariant tests         |
| Sale idempotency & tenant model   | Rigbe  | `adr/0007-*` + e2e demo                |
| SLIs/SLOs & budget policy         | Rigbe  | `slo-error-budgets.md`                 |
| Telemetry (spans/metrics/logs)    | Rigbe  | Grafana export + traces                |
| Alerting & recovery               | Rigbe  | `runbook.md` + game day                |
| CI/CD gates & promotion rule      | Meron  | `.github/workflows/` + pipeline run    |
| Threat model                      | Meron  | `threat-model.md`                      |
