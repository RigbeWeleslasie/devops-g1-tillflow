# What Payments and Commission need from infra

**For:** Meron (Platform + delivery) · **From:** Nebyat (Payments + integrity) ·
**Status:** the code is written and tested; these are the infra changes it needs before
it can run in ECS.

Nothing here is a blocker for G2's *correctness* evidence — the invariant tests need no
AWS at all. It is the list that stands between the services and a running deployment.

---

## 1. A secret that does not exist yet — `devops-g1/service-token`

**Blocking.** All three services read `SERVICE_TOKEN` at boot and refuse to start without
it (minimum 16 characters). `infra/secrets.tf` currently creates `db`, `daraja`,
`slack-webhook`, `<service>/db` and `<service>/db-password` — there is no service token.

It guards the routes that are reachable from the internet through API Gateway but should
only ever be called by another service: POS's `/internal/daily-close`, and Payments'
`/charges`, `/payouts` and `/admin/*`. This is the G2 "authz header" from
[`threat-model.md`](../../docs/threat-model.md) §3.2.

Same shape as the existing placeholder secrets — one value, injected into **all three**
task definitions:

```hcl
resource "aws_secretsmanager_secret" "service_token" {
  name        = "${local.prefix}/service-token"
  description = "Shared bearer token for service-to-service calls (POS /internal/*, Payments /charges, /payouts, /admin/*)"
  kms_key_id  = aws_kms_key.secrets.arn
  # ... tags as the others
}
```

The value can be generated the way `random_password.db_master` is. It must be identical
across `pos`, `payments` and `commission`.

## 2. Environment variables per task definition

Currently `infra/ecs.tf` injects only `SERVICE_NAME`, `ENVIRONMENT`, `PORT` and the OTel
trio. Each service needs more. Required values marked ✅ kill the process at boot if
absent — deliberately, so a misconfiguration fails at deploy rather than at 00:15 EAT.

### `devops-g1-pos`

| Variable | Source |
| --- | --- |
| `DATABASE_URL` ✅ | `devops-g1/pos/db` + `/db-password` |
| `JWT_SECRET` ✅ | new, or reuse an existing secret |
| `PAYMENTS_BASE_URL` ✅ | `http://devops-g1-payments.<namespace>:8080` |
| `SERVICE_TOKEN` ✅ | `devops-g1/service-token` |

### `devops-g1-payments`

| Variable | Source |
| --- | --- |
| `DATABASE_URL` ✅ | `devops-g1/payments/db` + `/db-password` |
| `SERVICE_TOKEN` ✅ | `devops-g1/service-token` |
| `MPESA_CALLBACK_BASE_URL` ✅ | **the public API Gateway URL**, e.g. `https://<api-gw>/payments` — Daraja posts here from the internet |
| `MPESA_ADAPTER` | `daraja` in prod. The service **refuses to start** with `fake` when `ENVIRONMENT=prod` |
| `DARAJA_*` (8 vars) | `devops-g1/daraja` |
| `SALE_EVENTS_QUEUE_URL` | `aws_sqs_queue.main["sale-events"].url` |
| `RECONCILE_*`, `OUTBOX_INTERVAL_MS` | optional; defaults are sensible |

### `devops-g1-commission`

| Variable | Source |
| --- | --- |
| `DATABASE_URL` ✅ | `devops-g1/commission/db` + `/db-password` (shares the `payments` schema/role) |
| `SERVICE_TOKEN` ✅ | `devops-g1/service-token` |
| `POS_BASE_URL` ✅ | `http://devops-g1-pos.<namespace>:8080` |
| `PAYMENTS_BASE_URL` ✅ | `http://devops-g1-payments.<namespace>:8080` |
| `CLOSE_QUEUE_URL` ✅ | `aws_sqs_queue.main["commission-payout"].url` |

## 3. Service-to-service networking

POS calls Payments, and Commission calls both. Today's security groups allow
VPC Link → ALB → tasks; I could not find a path for **task → task**.

Either is fine, and it's your call:

- **Through the internal ALB** — needs the tasks' SG to allow egress to the ALB SG, and
  the ALB to accept from the task SG. `*_BASE_URL` then points at the ALB with the
  service's path prefix.
- **Service discovery** (`aws_service_discovery_*`) — `*_BASE_URL` points at
  `http://devops-g1-pos.<namespace>:8080`, and task SGs allow each other on 8080.

The `*_BASE_URL` variables above assume service discovery; they are trivially changed.

## 4. Migrations must run before the services start

Both schemas and both least-privilege roles are created by migration runners, not by
Terraform:

```bash
ADMIN_DATABASE_URL=<rds master> npm run migrate --workspace=@tillflow/pos      -- --write-secret
ADMIN_DATABASE_URL=<rds master> npm run migrate --workspace=@tillflow/payments -- --write-secret
```

`--write-secret` writes the generated app password to
`devops-g1/<service>/db-password`, which is where the running service reads it from.
This is the job [`infra/secrets.tf`](../../infra/secrets.tf) refers to in its comment
about G2. It needs a way to run — a one-off ECS task, a CodeBuild step, or a bastion.

**Commission needs no migration of its own.** It shares the `payments` schema and role.

## 5. ECR repositories

`aws_ecr_repository.service` already covers all four services via `for_each`, so
`devops-g1/payments` and `devops-g1/commission` exist. Nothing needed.

## 6. Two things that are already right — please keep them

- **`ReadDarajaCredentials` scoped to the `payments` task role alone** (`infra/data.tf`).
  This is one of three independent layers stopping Commission from calling Daraja, and
  it's the only one that holds if the code is wrong. The G2 gate fails on a direct Daraja
  call from Commission.
- **Per-queue, per-direction SQS grants.** Payments produces to `sale-events`, POS
  consumes it; Commission consumes `commission-payout`. The current `queue_consume` /
  `queue_produce` locals match what the code does exactly.

## 7. Not needed for G2

`REDIS_URL` — nothing in Payments or Commission uses ElastiCache yet. Cache-aside is a
G3 concern once k6 shows where it helps.

---

## Quick verification once deployed

```bash
# All three healthy and reporting the same commit
for s in pos payments commission; do curl -s https://<api-gw>/$s/version; echo; done

# Service auth is actually enforced (both must be 401)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<api-gw>/payments/charges
curl -s -o /dev/null -w '%{http_code}\n' https://<api-gw>/pos/internal/daily-close?businessDay=2026-09-14

# Nothing is stuck
curl -s -H "x-service-token: $SERVICE_TOKEN" https://<api-gw>/payments/admin/pending
```
