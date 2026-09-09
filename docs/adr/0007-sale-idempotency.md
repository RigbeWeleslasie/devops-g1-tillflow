# ADR 0007 — Sale model, tenancy & idempotency boundary

- **Status:** Accepted
- **Date:** 2026-09-09
- **DRI:** Rigbe (Product + POS)
- **Required proof:** end-to-end sale demo + tests showing a duplicate `POST /sales`
  creates no second row

## Context

Product+POS owns the tenant model, the sale state machine, request contracts and the
validation boundary. Decisions here constrain Payments (charge is keyed on `sale_id`) and
Reliability (the POS SLI is "valid sale writes accepted exactly once").

## Decision

### Tenancy

- Single shared DB, **row-level `tenant_id`** on every `pos_*` table. No schema-per-tenant.
- Every query is scoped by `tenant_id` derived from the authenticated principal, never
  from the request body. A `tenant_id` mismatch is a 404 (not 403 — don't leak existence).
- Tenant-scoped roles: `owner` (configures till, attendants, rates, roles) and
  `attendant` (records sales only). Enforced in the POS API, asserted in tests.

### Sale state machine

```
DRAFT ──add line items──▶ OPEN ──finalize──▶ UNPAID ──payment PAID event──▶ PAID
                                     │
                                     └──void (owner only, before pay)──▶ VOID
```

- `PAID` and `VOID` are terminal. A sale only becomes `PAID` on a `sale.paid` event from
  Payments (SQS), idempotent on `sale_id`. POS never sets `PAID` itself.
- Totals are computed server-side from line items in **integer minor units**; a client
  total that disagrees is a 422.

### Idempotency contract

- `POST /sales` **requires** `Idempotency-Key` (UUID v4, client-generated per attempt).
- Storage: `pos_idempotency_keys(tenant_id, key) UNIQUE → (sale_id, response_hash, created_at)`.
- Behaviour:
  - key unseen → create sale, store key, return `201`.
  - key seen, same request body hash → return the stored `201` body (no new row).
  - key seen, **different** body hash → `409 Conflict` (key reuse bug on the client).
  - keys older than 24h are purged (a retry after a day is a new sale).
- `POST /sales/{id}/pay` is idempotent on sale state: calling it while `PENDING`/`PAID`
  returns the current charge, does not start a second STK Push.

### Validation boundary

- All external input validated at the API edge (schema + business rules) before any DB
  write. Money fields: non-negative integers, within tenant limits.
- Line-item quantity > 0, price ≥ 0, product belongs to tenant catalog.

## Consequences

- Schema: `pos_tenants`, `pos_users`, `pos_attendants`, `pos_products`,
  `pos_commission_rates`, `pos_sales`, `pos_sale_items`, `pos_idempotency_keys`.
- The POS SLI numerator = sales accepted with exactly-once semantics; a duplicate that
  correctly returns the first response counts as success, not error.
- Payments depends on `sale_id` being stable and unique — guaranteed here.
- Commission reads only `pos_sales.status = PAID` for the business day (via an API or a
  read-scoped view), never `UNPAID`/`OPEN`.
