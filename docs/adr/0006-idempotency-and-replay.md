# ADR 0006 — Idempotency & replay strategy

- **Status:** Accepted
- **Date:** 2026-09-09
- **DRI:** Nebyat (Payments + integrity)
- **Required proof:** invariant tests (no double charge, no double payout, one legal
  transition per callback) + a trace explaining a replayed callback

## Context

Requests time out, callbacks repeat and reorder, and the daily close may be re-run.
Invariants that must hold no matter what:

- **I1** One sale per idempotency key.
- **I2** One charge per sale; a retry after a timeout never creates a second charge.
- **I3** A callback applies **exactly one** legal state transition and **one** ledger
  effect, regardless of how many times or in what order it arrives.
- **I4** One payout per (tenant, attendant, business day). Re-running the close = no-op.
- **I5** A timeout leaves state `PENDING`, never `FAILED`.

## Decision

### Idempotency keys (client-supplied)

- `POST /sales` requires an `Idempotency-Key` header. `pos` stores
  `(tenant_id, idempotency_key) UNIQUE` with the resulting `sale_id` and the response
  hash. Replay returns the stored response (I1).
- `POST /charges` is idempotent on `sale_id` (`UNIQUE(sale_id)` in `payments_charges`).
  Second call returns the existing charge (I2).

### Callback dedupe + single-transition (I3)

- Every inbound callback is written first to `payments_callback_events`
  (`UNIQUE(checkout_request_id, result_code, checksum)`), inside the same transaction that
  applies the state change. A duplicate row insert → unique violation → the handler
  returns 200 without re-applying anything.
- State transitions are guarded by a whitelist and applied with an optimistic condition:
  `UPDATE ... SET status = :new WHERE id = :id AND status = :expected`. If 0 rows change,
  the transition was already done (or illegal) → no second ledger effect.
- Legal transitions only:
  - Charge: `PENDING → PAID`, `PENDING → FAILED`. `PAID`/`FAILED` are terminal.
  - Payout: `PENDING → PAID`, `PENDING → FAILED`. Terminal.
- The ledger effect (crediting `sale.paid`, marking payout settled) happens in the **same
  DB transaction** as the guarded status update — never as a separate step.

### Reconciliation, not guessing (I5)

- STK ack timeout / missing callback → charge stays `PENDING`.
- A reconciler job (every 5 min) calls `stkQuery` for `PENDING` charges older than a
  threshold and resolves them via the same guarded transition + dedupe path.
- Still ambiguous after `MAX_RECONCILE_ATTEMPTS` → stays `PENDING`, raises a Slack alert;
  a human uses the runbook. We never auto-fail a pending payment.

### Daily close replay safety (I4)

- `payments_payout_ledger` has `UNIQUE(tenant_id, attendant_id, business_day)`.
- The worker computes the amount, then `INSERT ... ON CONFLICT DO NOTHING`. Conflict ⇒
  already computed ⇒ skip.
- The B2C request to the Payments API is idempotent on `ledger_id`
  (`UNIQUE(ledger_id)` in `payments_payouts`).
- Result: re-running the EventBridge trigger, re-delivering the SQS message, or a worker
  crash mid-run all converge to exactly one payout per row. **Duplicate disbursement = 0.**

### Money & rounding

- All amounts are integer minor units. Commission = `floor(sale_total_minor * rate_bps / 10000)`
  computed per sale then summed (rounding rule documented once, applied everywhere).

## Consequences

- Schema adds: `pos_idempotency_keys`, `payments_callback_events`, unique constraints on
  `charges.sale_id`, `payout_ledger(tenant,attendant,day)`, `payouts.ledger_id`.
- Every callback/payout handler is wrapped in one DB transaction; no cross-service
  distributed transaction — events (SQS) carry the "sale is paid" signal to `pos` and are
  themselves idempotent on `sale_id`.
- Traces tag `messaging.message_id`, `mpesa.checkout_request_id`, `payout.ledger_id` so a
  replayed callback is visible as "second span, zero writes".
- Tests: property/invariant suite replays and reorders callbacks and re-runs closes;
  asserts I1–I5.
