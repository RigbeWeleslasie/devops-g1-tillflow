# evidence/product-pos

**DRI:** Rigbe — Product + POS (G2 Track A)

## What's proven

| Claim | Proof | Reproduce |
| --- | --- | --- |
| **I1** — duplicate `POST /sales` (same body) returns the first response, creates no second row; same key + different body → 409 | `services/pos/test/idempotency.test.ts` (6 tests, service-layer + HTTP-layer) | `cd services/pos && npm test` |
| **IDOR** — cross-tenant read is a 404, indistinguishable from a nonexistent id | `services/pos/test/idor.test.ts` (3 tests) | `cd services/pos && npm test` |
| End-to-end: sale → pay → `sale.paid` consumed → `PAID` | `services/pos/test/saleFlow.test.ts` (3 tests) + narrated demo run, real output below | `cd services/pos && npx tsx scripts/demo.ts` |
| `sale.paid` idempotent on `sale_id` — redelivery, duplicate publish, and reordering across two sales all converge to exactly one `PAID` transition | `services/pos/test/salePaidConsumer.test.ts` (4 tests) | `cd services/pos && npm test` |
| Server recomputes the sale total from the product catalog — a client-sent price/total is never trusted | `saleService.createSale` always reads `unit_price_minor` from `products`, ignores any price in the request body; exercised in every sale-creation test and the demo (step 1: 3 × 25000 → `totalMinor: 75000`) | see demo output below |
| Money stays integer minor units end to end, one documented rounding rule (`floor`) | `services/_shared/ts/test/money.test.ts` (9 tests) | `cd services/_shared/ts && npm test` |
| A failed/timed-out call to Payments leaves the sale `UNPAID` with no `chargeId` — never a fabricated `FAILED` | `services/pos/test/saleFlow.test.ts` ("a timed-out charge attempt...") | `cd services/pos && npm test` |

**29/29 tests passing** across the three affected workspaces (`@tillflow/shared`,
`@tillflow/pos`, `@tillflow/web`) as of this writing. Full captured run:
[`full-test-run-output.txt`](full-test-run-output.txt).

## Reproduce everything from a clean clone

```bash
git checkout feat/g2-pos-track-a   # or main, once merged
npm install                         # root — npm workspaces
npm run build                       # builds @tillflow/shared, @tillflow/pos, @tillflow/web
npm run test --workspace=@tillflow/shared --workspace=@tillflow/pos --workspace=@tillflow/web
```

No Postgres, no Docker, no AWS credentials needed — every test runs against `pg-mem`
(loading the real `services/pos/migrations/*.sql`, not a simplified schema) or an
in-process fake (`FakePaymentsClient`, `FakeEventSource`, `test/fakePos.ts`).

## End-to-end sale demo — real, captured output

`services/pos/scripts/demo.ts` runs the full flow (create → duplicate → conflict → pay →
still-unpaid → sale.paid consumed → paid → IDOR check) against a fresh in-memory DB and
narrates every step. Run it yourself with `cd services/pos && npx tsx scripts/demo.ts`.

Captured output (this exact run, unedited): [`e2e-sale-demo-output.txt`](e2e-sale-demo-output.txt).

Highlights from that run:
- Step 1: `POST /sales` for 3× a 25000-minor-unit product → `totalMinor: 75000`, status `UNPAID`.
- Step 2: identical duplicate request → same `201`, same sale id, **1 row** in the DB.
- Step 3: same key, different body → `409 idempotency_key_conflict`.
- Step 4: `POST /sales/{id}/pay` → `202`, Payments client received exactly
  `{saleId, amountMinor: 75000, tenantTill: "123456"}`.
- Step 5: still `UNPAID` immediately after pay — only the async event may set `PAID`.
- Step 6–7: a `sale.paid` event is consumed → sale flips to `PAID` with a `paidAt`.
- Step 8: a second tenant's owner reading the same sale id gets `404 {"error":"not_found"}`
  — identical to what a made-up id returns.

## Architecture / decisions this evidence backs

- [`docs/adr/0007-sale-idempotency.md`](../../docs/adr/0007-sale-idempotency.md) — sale
  model, tenancy, idempotency contract
- [`docs/adr/0006-idempotency-and-replay.md`](../../docs/adr/0006-idempotency-and-replay.md) —
  I1/I3-style invariant design (POS's `sale_paid_events` dedupe mirrors Payments' own
  callback-dedupe pattern)
- [`docs/scar-log.md`](../../docs/scar-log.md) — three real bugs caught and fixed while
  building this (sale/sale_items insert ordering, a pg-mem concurrency-testing limitation,
  and a content-type bug in the web shell's POS client that would have broken `/pay` in
  the real deployment too)

## What this evidence does NOT cover (honest gaps)

- No real Postgres/RDS connection has been exercised — see
  `services/pos/README.md`#"What isn't proven yet".
- No Docker build has been run (no Docker in this environment) — `Dockerfile` is written
  for both `pos` and `web`, untested.
- No integration with a real Payments service — Nebyat's track. Every test here uses
  `FakePaymentsClient` / `test/fakePos.ts`, matching the documented contract
  (`POST /charges`) but not the real implementation.
- `docs/gates.md` G2 status reflects exactly this: Track A code + tests complete,
  not yet deployed or integrated with Track B.
