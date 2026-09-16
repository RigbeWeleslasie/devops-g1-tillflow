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

---

## Amendment — 2026-09-15 (G2 implementation)

Three things the original decision did not anticipate, all discovered while
making I3 and I5 actually hold. None changes an invariant; each closes a gap
the first draft left open.

### 1. Re-association after a timed-out push (I5)

The draft said a timed-out STK push stays `PENDING` and the reconciler
resolves it by `stkQuery`. That works only when we HAVE a
`CheckoutRequestID` — and a push that times out never returns one. Daraja
offers no way to query by our own reference, so such a charge is
unqueryable, and any callback that later arrives matches nothing.

**Decision:** a success callback whose reference is unknown may ADOPT a
charge whose push timed out, if and only if exactly one candidate matches on
MSISDN, amount, `status='PENDING'`, `checkout_request_id IS NULL`, and
creation within 30 minutes. Two candidates ⇒ adopt neither and leave both
for a human. Crediting the wrong sale is worse than staying stuck.

### 2. The `hold` state (threat model A1)

The draft had two outcomes for a callback: apply, or ignore as a duplicate.
It had nothing to say about a callback that is well-formed, matches a charge
we issued, and reports an amount we never charged.

**Decision:** such a charge gets `hold_reason` set and NO transition. While
held, no automatic path may resolve it — not the reconciler, and not the
genuine callback that may follow. `POST /admin/charges/:id/release` clears
it after a human decides. This is "never guess" made concrete: when two
callbacks disagree about money, picking a winner automatically is guessing.

### 3. `payout_minor` and `remainder_minor` (money)

The draft's rounding rule produces an exact commission in minor units. M-Pesa
B2C pays whole shillings, so an exact commission of KES 5.05 cannot be sent.

**Decision:** `payout_ledger` records all three numbers — `amount_minor`
(exact), `payout_minor` (floored to a shilling, what B2C sends), and
`remainder_minor` (the cents that stay with the tenant). The truncation is
auditable rather than silent, and `payout + remainder == amount` is asserted
by test. Consequence: **product prices must be whole shillings**
(`unit_price_minor % 100 == 0`), since both adapters refuse a
fractional-shilling amount rather than rounding it.

### Schema additions beyond the draft

`charges.hold_reason`, `charges.reconcile_attempts`,
`charges.last_reconciled_at`, `charges.resolved_by`, `outbox_events`
(the transactional outbox that makes "one ledger effect" a database
constraint rather than a code path), `payout_ledger.payout_minor` /
`remainder_minor`, and `close_runs` (so a replay is provable from the
database alone).
