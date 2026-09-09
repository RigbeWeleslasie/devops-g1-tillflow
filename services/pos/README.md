# pos — POS API

**DRI:** Rigbe (Product + POS) · **ECS service:** `devops-g1-pos` · **ECR:** `devops-g1/pos`
· **DB schema:** `pos` · **DB role:** `devops-g1-pos-app`

Tenant setup (till, attendants, commission rates, tenant-scoped roles), product catalog,
and the **sale state machine**. Idempotent sale creation.

## Sale state machine
`DRAFT → OPEN → UNPAID → PAID` (+ `VOID` from `OPEN`, owner only). `PAID` set only on a
`sale.paid` SQS event from `payments` (idempotent on `sale_id`). See `docs/adr/0007-sale-idempotency.md`.

## Key endpoints (contract firmed in G2)
- `POST /tenants`, `POST /tenants/{id}/attendants`, `POST /tenants/{id}/rates` — owner only
- `POST /sales` — **requires `Idempotency-Key`**; integer minor units; server recomputes totals
- `POST /sales/{id}/pay` — triggers charge via `payments`; idempotent on sale state
- `GET /sales/{id}`
- `GET /health` `GET /ready` `GET /version`

## SLI
Valid sale writes accepted exactly once ≥ 99.9%; p95 < 400 ms.

## Invariants
I1 one sale per idempotency key. Duplicate `POST /sales` (same body) returns the first
response, creates no row. Different body + same key → 409.

## Evidence
`evidence/product-pos/` — end-to-end sale demo + idempotency tests.
