# payments — Payments API (Daraja owner)

**DRI:** Nebyat (Payments + integrity) · **ECS service:** `devops-g1-payments` ·
**ECR:** `devops-g1/payments` · **DB schema:** `payments` · **DB role:** `devops-g1-payments-app`

**Sole owner of Daraja.** Auth (OAuth), STK Push, STK query, callbacks, B2C, reconciliation.
No other service talks to Daraja.

## Key endpoints (contract firmed in G2)
- `POST /charges` — idempotent on `sale_id`; `PENDING` → Daraja STK Push
- `POST /callbacks/stk` — Daraja STK result callback (deduped, single guarded transition)
- `POST /payouts` — idempotent on `ledger_id`; `PENDING` → Daraja B2C
- `POST /callbacks/b2c` — B2C result callback
- `POST /admin/reconcile` / scheduled — `stkQuery` for stale `PENDING` charges
- `GET /health` `GET /ready` `GET /version`

## Invariants (see `docs/adr/0006-idempotency-and-replay.md`)
- I2 one charge per sale; timeout retry never creates a second
- I3 one legal transition + one ledger effect per callback, any order / count
- I5 timeout ⇒ stays `PENDING`, never `FAILED`

## Adapter
`MPESA_ADAPTER=daraja` in prod, `fake` everywhere else. Interface + deterministic fake:
`services/_shared/mpesa/`, `docs/adr/0005-mpesa-fake-adapter.md`.

## SLI
Valid STK/B2C accepted and callbacks processed within 60s ≥ 99.5%. A correctly-held
timeout counts as success.

## Evidence
`evidence/payments-integrity/` — invariant tests + traces (sale → STK → callback → reconcile).
