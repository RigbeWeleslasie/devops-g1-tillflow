# commission — Commission worker

**DRI:** Nebyat (Payments + integrity) · **ECS service:** `devops-g1-commission` (worker) ·
**ECR:** `devops-g1/commission` · **DB schema:** `payments` (the payout ledger)

Daily close. Computes each attendant's commission from **confirmed PAID sales only**,
writes the payout ledger, and requests B2C **through the Payments API**.

**G2 status:** implemented and tested (38 tests, `npm test --workspace=@tillflow/commission`).
Not yet deployed. See [`docs/gates.md`](../../docs/gates.md).

## It never calls Daraja — three independent layers

1. **No dependency.** `@tillflow/mpesa` is absent from `package.json`, and the Dockerfile
   does not install it. `grep -c mpesa services/commission/package.json` → `0`.
2. **Architecture.** The only path to money is `POST /payouts`
   ([`clients/paymentsClient.ts`](src/clients/paymentsClient.ts)).
3. **IAM.** `ReadDarajaCredentials` in [`infra/data.tf`](../../infra/data.tf) is scoped to
   the `payments` task role alone. This task cannot read `devops-g1/daraja` even if the
   code tried.

## How a close runs

```
EventBridge Scheduler  cron(15 0 * * ? *)  Africa/Nairobi
        │  {"type":"daily_close"}
        ▼
devops-g1-commission-payout (SQS)
        ▼
closeWorker ── derives the day that just ENDED, in Nairobi
        ├─ GET  pos:/internal/daily-close?businessDay=…   (per-sale amounts, rate, msisdn)
        ├─ per attendant: floor(total × rate_bps / 10000) PER SALE, then summed
        ├─ INSERT … ON CONFLICT DO NOTHING  → payout_ledger   ← I4
        └─ POST payments:/payouts { ledgerId }               ← idempotent on ledgerId
        ▼
ack the trigger — only after the close commits
```

The trigger carries no business day, so the worker derives it. A UTC-based worker firing
at 00:15 EAT would close the **wrong day**; a test pins that. A message may name an
explicit `businessDay`, which is what makes a drill or a re-close reproducible.

## Why it is replay-safe (I4)

| Failure | What happens |
| --- | --- |
| Trigger redelivered (SQS at-least-once) | Close re-runs, `ON CONFLICT DO NOTHING` inserts nothing, nothing re-paid |
| EventBridge retries (3 attempts) | Three triggers, one ledger row, one payment |
| Crash between ledger write and payout request | Row stays `COMPUTED`; the next run requests it. **Never `FAILED`** |
| Payments unreachable | `outcome: 'unknown'` → row stays `COMPUTED` → retried next run. The worker never invents a failure |
| Two tasks close at once | Advisory lock; the loser leaves the trigger for redelivery |

**Duplicate disbursement = 0.** Reproduction:
[`evidence/payments-integrity/`](../../evidence/payments-integrity/).

## Money

`floor(total_minor × rate_bps / 10000)` **per sale, then summed** — the single rule in
[`@tillflow/shared/money`](../_shared/ts/src/money.ts). Flooring an aggregate gives a
different answer (three KES 100.50 sales at 5%: 1506 per-sale, 1507 aggregate), which is
why POS returns per-sale amounts.

B2C pays whole shillings, so each ledger row records three numbers:

| Column | Meaning |
| --- | --- |
| `amount_minor` | the exact commission |
| `payout_minor` | floored to a whole shilling — what B2C actually sends |
| `remainder_minor` | the cents that stay with the tenant |

`payout + remainder == amount`, asserted by test. An attendant earning under one shilling
gets a `SKIPPED` row rather than being omitted — the day's ledger is complete either way.

`rate_bps` and `msisdn` are **snapshot** into the row at compute time (threat model
A5/A7): a later rate edit or phone change cannot rewrite a computed payout.

## Ledger states

```
COMPUTED  → REQUESTED   (Payments accepted the payout)
REQUESTED → PAID | FAILED   (B2C result callback, applied by Payments)
COMPUTED  → SKIPPED     (payout_minor = 0 — nothing to send)
```

## Operating it

```bash
# Close a specific day (the runbook's command)
npm run close --workspace=@tillflow/commission -- --day 2026-09-14

# See what WOULD be written, touching neither the ledger nor Payments.
# Safe against prod while deciding whether to re-close.
npm run close --workspace=@tillflow/commission -- --day 2026-09-14 --dry-run
```

Running the close twice **is** the replay drill — the second run prints
`replay: every ledger row already existed — nothing was recomputed, nothing re-paid`.

## Runtime configuration

`SERVICE_TOKEN` and `DATABASE_URL` come from Secrets Manager via the task definition.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ | — | `devops-g1/commission/db` + `/db-password`. Shares the `payments` schema and role |
| `SERVICE_TOKEN` | ✅ | — | `devops-g1/service-token`. Same value as POS and Payments |
| `POS_BASE_URL` | ✅ | — | e.g. `http://devops-g1-pos.internal:8080` |
| `PAYMENTS_BASE_URL` | ✅ | — | e.g. `http://devops-g1-payments.internal:8080` |
| `CLOSE_QUEUE_URL` | ✅ for the worker | — | `devops-g1-commission-payout`. The CLI does not need it |
| `HTTP_TIMEOUT_MS` | — | `30000` | A whole day's snapshot can be large |
| `SQS_WAIT_SECONDS` | — | `20` | Matches the queue's `receive_wait_time_seconds` |
| `PORT` | — | `8080` | `/health` `/ready` `/version` only |
| `AWS_REGION` | — | `us-east-1` | |

**Note for the task definition:** SQS visibility timeout is set to 300 s in code so a
whole close finishes before the trigger reappears.

## Tests

```bash
npm test --workspace=@tillflow/commission    # 38 tests, no AWS, no DB, no network
```

Both boundaries (POS, Payments) are interfaces with fakes. The `payments` migrations are
loaded into `pg-mem`, so the ledger's constraints are the real ones.
