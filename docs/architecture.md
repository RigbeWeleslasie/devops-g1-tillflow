# Architecture — TillFlow / devops-g1

## 1. Context

Multi-tenant SaaS point-of-sale. A tenant (shop owner) configures a till, attendants and
commission rates. Attendants record sales; customers pay via M-Pesa STK Push against the
tenant till; a daily close pays each attendant's commission via M-Pesa B2C.

Correctness under partial failure is the whole point:
- **A timeout is not a decline** — an uncertain payment stays `pending` and is resolved
  by transaction query / reconciliation, never by guessing.
- **Replay must never double-pay** — repeated callbacks and re-run daily closes converge
  to exactly one ledger effect.

## 2. High-level diagram

```
                         ┌────────────────────────── AWS us-east-1 ──────────────────────────┐
                         │                                                                  │
  Customer phone         │   ┌───────────────┐    VPC Link     ┌───────────────────────┐     │
  (M-Pesa STK prompt)    │   │  API Gateway  │───────────────▶ │  Internal ALB          │    │
        ▲   │            │   │  (HTTP API)   │                 │  (private subnets, 2AZ)│    │
        │   ▼            │   └───────────────┘                 └───────────┬───────────┘     │
  ┌───────────────┐      │           ▲                                     │                 │
  │  Daraja 3.0   │      │           │ HTTPS                               │ path-routed     │
  │  sandbox      │◀─────┼───────────┘                     ┌───────────────┼───────────────┐ │
  │  (STK / B2C / │      │                                 ▼               ▼               ▼ │
  │   query)      │      │   ┌──────────┐        ┌──────────┐   ┌──────────┐   ┌──────────┐  │
  │      │        │      │   │  web     │        │  pos     │   │ payments │   │commission│  │
  │      │callback│      │   │ (ECS)    │        │ (ECS)    │   │ (ECS)    │   │(ECS/wkr) │  │
  └──────┼────────┘      │   └────┬─────┘        └────┬─────┘   └────┬─────┘   └────┬─────┘  │
         │               │        │  each task = app + ADOT sidecar │              │        │
         └──callback POST─┼───────────────────────────────────────▶ │              │        │
           (via API GW)  │        │                   │             │              │        │
                         │        ▼                   ▼             ▼              ▼        │
                         │   ┌─────────────────────────────────────────────────────────┐   │
                         │   │  RDS PostgreSQL (Multi-AZ)   schemas: pos_* payments_*   │   │
                         │   │  ElastiCache Redis/Valkey    cache-aside                 │   │
                         │   │  SQS + DLQ                   commission jobs, callbacks  │   │
                         │   │  EventBridge Scheduler       daily close ~00:15 EAT      │   │
                         │   │  S3                          tfstate/artifacts/logs/     │   │
                         │   │                              backups/evidence           │   │
                         │   └─────────────────────────────────────────────────────────┘   │
                         │                                                                  │
                         │   Telemetry: ADOT sidecar ──OTLP──▶ CloudWatch / AMP            │
                         │              ADOT sidecar ──X-Ray──▶ Grafana (traces)           │
                         │   Synthetic: 1-minute external probe (Terraform-provisioned)     │
                         └──────────────────────────────────────────────────────────────────┘
```

## 3. Services

| Service      | Runtime           | Responsibility                                                                 | Data (schema)        |
| ------------ | ----------------- | ----------------------------------------------------------------------------- | -------------------- |
| `web`        | ECS Fargate (HTTP)| Frontend / API shell; serves the attendant + owner UI, proxies to APIs.        | none (calls APIs)    |
| `pos`        | ECS Fargate (HTTP)| Tenant setup, attendants, sales. Sale state machine. Idempotent sale creation. | `pos_*`              |
| `payments`   | ECS Fargate (HTTP)| **Sole owner of Daraja**: auth, STK Push, callbacks, query, B2C, reconciliation.| `payments_*`         |
| `commission` | ECS Fargate (worker)| Daily close: reads confirmed-paid sales, writes payout ledger, calls Payments API for B2C. **Never calls Daraja directly.** | `payments_*` (ledger)|
| `_shared`    | library           | M-Pesa adapter interface, OTel/ADOT setup, Docker base image, common types.    | —                    |

### Service boundaries (hard rules)

1. Only `payments` talks to Daraja. `commission` requests B2C **through the Payments API**.
   A direct Daraja call from `commission` fails G2.
2. `pos` never writes `payments_*`; `payments` never writes `pos_*`. Cross-service reads
   go over HTTP APIs or are denormalized via events.
3. Money is **integer minor units** (KES cents) end-to-end. No floating point.
4. Each service connects to RDS with its **own least-privilege role** scoped to its schema.

## 4. Request flows

### 4.1 Sale → payment → paid

```
attendant ─▶ POS /sales  (Idempotency-Key header)
             └─ pos: insert sale(status=UNPAID) if key unseen; else return existing
attendant ─▶ POS /sales/{id}/pay
             └─ pos ─▶ payments POST /charges { saleId, amountMinor, tenantTill }
                       └─ payments: insert charge(status=PENDING, idempotent on saleId)
                       └─ payments ─▶ Daraja STK Push
                                      ├─ 200  → store CheckoutRequestID, stay PENDING
                                      └─ timeout → stay PENDING (NOT failed)  ◀── "timeout is not a decline"
Daraja ─▶ API GW ─▶ payments POST /callbacks/stk
             └─ payments: dedupe on CheckoutRequestID; apply ONE transition
                          PENDING → PAID (ResultCode 0) | PENDING → FAILED (declined)
                          emit sale.paid event (SQS) → pos marks sale PAID
reconciler (cron, every 5 min): for each PENDING older than N min → Daraja query →
             resolve to PAID/FAILED; still ambiguous → leave PENDING + alert
```

### 4.2 Daily close → commission → B2C

```
EventBridge (00:15 EAT) ─▶ SQS ─▶ commission worker
  for each tenant:
    sales = confirmed PAID sales for the business day
    for each attendant:
      amountMinor = sum(sale.total * rate)  (integer math, documented rounding)
      payout_ledger.insert(tenant, attendant, day, amountMinor)   -- UNIQUE(tenant,attendant,day)
        └─ on conflict: skip (already computed) ◀── replay safe
      commission ─▶ payments POST /payouts { ledgerId, msisdn, amountMinor }
                    └─ payments: idempotent on ledgerId; PENDING → Daraja B2C
    B2C result callback ─▶ payments ─▶ ledger row → PAID / FAILED (one transition)
```

Re-running the close for the same day is a no-op: the `UNIQUE(tenant, attendant, day)`
constraint plus `ledgerId`-idempotent payouts guarantee **zero double disbursement**.

## 5. Platform baseline

- **Edge:** API Gateway (HTTP API) → VPC Link → internal ALB. ALB access logs → S3.
- **Compute:** 4 ECS Fargate services, private subnets, 2 AZs. Each task = app container +
  **ADOT Collector sidecar**. `/health` (liveness) and `/ready` (readiness) on every app.
- **State:**
  - RDS PostgreSQL, Multi-AZ, service-owned schemas + roles, PgBouncer/RDS Proxy pooling.
  - ElastiCache Redis/Valkey — cache-aside for tenant config, rates, catalog.
  - SQS + DLQ for `sale.paid` events, commission jobs, callback processing.
  - EventBridge Scheduler for the daily close.
- **Object storage (S3), one bucket per purpose:** `tfstate` (+ DynamoDB lock),
  `artifacts`, `logs`, `backups`, `evidence`. Versioning + KMS + block-public-access +
  lifecycle on each. See [`adr/0004`](adr/0004-object-storage-s3.md).
- **Secrets:** AWS Secrets Manager — `devops-g1/daraja`, `devops-g1/slack-webhook`,
  `devops-g1/db`. Never in Git, Terraform state, or build logs.
- **IaC:** Terraform manages *all* infrastructure, pipelines, secret references, alarms
  and dashboards. Console changes earn no evidence credit.

## 6. Telemetry

- Apps export **OTLP to `localhost:4317`** (the sidecar). Sidecar fans out to
  CloudWatch / Amazon Managed Prometheus and to X-Ray; Grafana reads both.
- **JSON logs** carry `trace_id` / `span_id` for every request.
- Span boundaries: inbound HTTP, DB query, cache op, outbound Daraja call, SQS publish/consume.
- Grafana panels (per service): 5m/1h/28d uptime, SLO target, budget remaining, burn rate,
  RED (rate/errors/duration), saturation (CPU/mem/queue age), and business signals
  (sales/min, STK success %, payouts settled, reconciliation backlog).
- A **1-minute external synthetic probe** is provisioned by Terraform.

## 7. Environments

Single environment `prod` for the capstone (documented as such). One AWS account, one
region (`us-east-1`). `environment=prod` tag on all resources. A throwaway restore target
is created on demand during G4 and destroyed after.

## 8. Delivery

- **GitHub Actions** — PR: lint, typecheck, tests, secret/dependency/IaC scan, Docker
  build, SBOM, image scan; `terraform plan` on PR. `main`: gated `terraform apply` via
  OIDC into `devops-g1-ci-deploy`.
- **AWS CodePipeline** — CodeConnections → CodeBuild (test/build) → scan gate → ECR
  (tagged by commit SHA, deployed by digest) → ECS deploy → post-deploy smoke → rollback
  on failure. Path filters / per-service stages so a change under `services/payments/`
  builds and deploys only Payments (+ its `_shared` deps).
- **No `latest` tags.** Commit SHA + immutable digest exposed in runtime `/version` and
  in pipeline evidence.

## 9. Open items carried into G1

- Confirm real GitHub handles → enable branch protection.
- Confirm AWS account ID → S3 bucket suffixes.
- Decide RDS instance class after k6 load model (G3 may revise; starter in `adr/0003`).
- Confirm Grafana hosting (Amazon Managed Grafana vs self-hosted on ECS).
