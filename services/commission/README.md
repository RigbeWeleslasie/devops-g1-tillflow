# commission — Commission worker

**DRI:** Nebyat (Payments + integrity) · **ECS service:** `devops-g1-commission` (worker) ·
**ECR:** `devops-g1/commission` · **DB schema:** `payments` (payout ledger)

Daily close. Triggered by EventBridge (~00:15 EAT) via SQS. For each tenant/attendant:
1. Sum commission from **confirmed PAID sales only** for the business day (integer math,
   `floor(total_minor * rate_bps / 10000)` per sale, then sum).
2. `INSERT ... ON CONFLICT DO NOTHING` into `payments_payout_ledger`
   (`UNIQUE(tenant_id, attendant_id, business_day)`).
3. Request B2C **through the Payments API** (`POST /payouts`, idempotent on `ledger_id`).

## Hard rules
- **Never calls Daraja directly** — no creds, no egress SG to Safaricom. A direct call
  fails G2.
- Replay safe: re-trigger / redelivered SQS message / mid-run crash → exactly one payout
  per ledger row. **Duplicate disbursement = 0.**
- Rate is snapshotted into the ledger row at compute time.

## SLI
Eligible payouts reach terminal state by 06:30 EAT ≥ 99.0%; duplicate disbursement = 0.

## Evidence
`evidence/payments-integrity/` — replay test (re-run close = no-op), trace of scheduled run.
