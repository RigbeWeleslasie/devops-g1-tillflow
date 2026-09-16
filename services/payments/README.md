# payments — Payments API (Daraja owner)

**DRI:** Nebyat (Payments + integrity) · **ECS service:** `devops-g1-payments` ·
**ECR:** `devops-g1/payments` · **DB schema:** `payments` · **DB role:** `devops-g1-payments-app`

**Sole owner of Daraja.** Auth, STK Push, STK query, callbacks, B2C, reconciliation.
No other service talks to Daraja — enforced by IAM, not convention
([`infra/data.tf`](../../infra/data.tf) scopes `ReadDarajaCredentials` to this task role).

**G2 status:** implemented and tested (80 tests, `npm test --workspace=@tillflow/payments`).
Not yet deployed — no image has run in ECS. See [`docs/gates.md`](../../docs/gates.md).

## Endpoints

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /charges` | `X-Service-Token` | Idempotent on `saleId`. 201 created / 200 already existed. **Never pushes twice.** |
| `GET /charges/:id`, `GET /charges/by-sale/:saleId` | `X-Service-Token` | Read-back |
| `POST /callbacks/stk` | none — Daraja cannot send our header | Deduped, guarded, amount cross-checked |
| `POST /payouts` | `X-Service-Token` | Idempotent on `ledgerId`. The only way B2C is requested |
| `GET /payouts/:id`, `GET /payouts/by-ledger/:ledgerId` | `X-Service-Token` | Read-back |
| `POST /callbacks/b2c`, `POST /callbacks/b2c-timeout` | none | Result and queue-timeout notices |
| `POST /admin/reconcile` | `X-Service-Token` | Run one reconcile pass now |
| `GET /admin/pending` | `X-Service-Token` | What is stuck, and **why**, in the runbook's words |
| `POST /admin/charges/:id/release` | `X-Service-Token` | Clear a hold after a human decides |
| `GET /health` `GET /ready` `GET /version` | none | Golden path |

There is deliberately **no** endpoint that sets a charge `PAID` or `FAILED` by hand, and a
test asserts those routes 404. Money state comes from Daraja — via a callback or a query —
and nowhere else. An operator can unblock a decision; they cannot invent one.

## Contract with POS

`POST /charges` — POS sends `{ saleId, tenantId, amountMinor, tenantTill, customerMsisdn }`
and gets back `{ chargeId, saleId, status, amountMinor, checkoutRequestId, created }`.
`tenantId` and `customerMsisdn` are required beyond the original G0 sketch: the
`sale.paid` event needs the tenant, and an STK push needs a phone number.

Amounts must be **whole shillings** (`amountMinor % 100 === 0`) — M-Pesa cannot carry
cents, and both adapters refuse a fractional amount rather than rounding it. A violation
is `400 amount_not_whole_shillings`.

## State machines

```
charge:  PENDING → PAID      (callback or query, ResultCode 0)
         PENDING → FAILED    (definite decline, or a synchronous 4xx rejection)
         PENDING → (held)    (callback amount ≠ ours — no transition, human required)
         a timeout changes NOTHING. There is no path from a timeout to FAILED.

payout:  PENDING → PAID | FAILED   (B2C result callback). Same timeout rule.
```

## Invariants ([ADR 0006](../../docs/adr/0006-idempotency-and-replay.md))

- **I2** one charge per sale; a timeout retry never creates a second
- **I3** one legal transition + one ledger effect per callback, any order, any count
- **I5** a timeout leaves state `PENDING`, never `FAILED`

Proof and reproduction commands: [`evidence/payments-integrity/`](../../evidence/payments-integrity/).

## Runtime configuration

Everything below is read once at startup; a missing required value kills the process at
boot rather than on the first request. **`SERVICE_TOKEN`, `DATABASE_URL` and the
`DARAJA_*` values come from Secrets Manager** via the task definition's `secrets` block.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ | — | `devops-g1/payments/db` + `/db-password` |
| `SERVICE_TOKEN` | ✅ | — | `devops-g1/service-token`. Min 16 chars. Shared with POS and Commission |
| `MPESA_CALLBACK_BASE_URL` | ✅ | — | Public base Daraja posts to, e.g. `https://<api-gw>/payments` |
| `MPESA_ADAPTER` | — | `fake` | `daraja` in prod; **`loadConfig` refuses `fake` when `ENVIRONMENT=prod`** |
| `DARAJA_BASE_URL` | if `daraja` | sandbox | |
| `DARAJA_CONSUMER_KEY` / `_SECRET` / `_PASSKEY` / `_SHORTCODE` | if `daraja` | — | `devops-g1/daraja` |
| `DARAJA_B2C_SHORTCODE` / `_INITIATOR` / `_SECURITY_CREDENTIAL` | if `daraja` | — | `devops-g1/daraja` |
| `SALE_EVENTS_QUEUE_URL` | — | unset | `devops-g1-sale-events`. **Unset ⇒ events pile up visibly in the outbox and the relay fails loudly** |
| `RECONCILE_AFTER_MS` | — | `120000` | Only query charges older than this |
| `RECONCILE_INTERVAL_MS` | — | `300000` | Reconciler tick |
| `RECONCILE_MAX_ATTEMPTS` | — | `12` | Then stop asking and alert. **Never auto-fail** |
| `OUTBOX_INTERVAL_MS` | — | `1000` | Relay tick |
| `PORT` | — | `8080` | |
| `AWS_REGION` | — | `us-east-1` | |

Background loops (reconciler, outbox relay) run under Postgres advisory locks, so several
tasks can run safely.

## Local development

```bash
npm ci                                              # repo root
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=x postgres:16
ADMIN_DATABASE_URL=postgres://... npm run migrate --workspace=@tillflow/payments
npm run dev --workspace=@tillflow/payments
```

With `MPESA_ADAPTER=fake` the fake delivers callbacks back to this service over HTTP on a
timer, so the whole callback path runs with no AWS and no Daraja.

## Tests

```bash
npm test --workspace=@tillflow/payments     # 80 tests, no AWS, no DB, no network
```

`pg-mem` is loaded with the **real** `migrations/*.sql`, so a constraint that would fail
against RDS fails here too.
