# pos — POS API

**DRI:** Rigbe (Product + POS) · **ECS service:** `devops-g1-pos` · **ECR:** `devops-g1/pos`
· **DB schema:** `pos` · **DB role:** `devops-g1-pos-app` · **Stack:** Node 22 · TypeScript · Fastify

Tenant setup (till, attendants, commission rates), product catalog, the **sale state
machine**, and idempotent sale creation. G2 status: implemented, tested (29 tests passing
across the workspace — `npm test`), not yet deployed (no image has been pushed/run in ECS;
see `docs/gates.md`).

## Sale state machine

`DRAFT → OPEN → UNPAID → PAID` (+ `VOID`) is the full model in
`docs/adr/0007-sale-idempotency.md`. G2's endpoints create a sale directly at `UNPAID`
(all line items supplied up front by `POST /sales`) — the `DRAFT`/`OPEN` staged-entry flow
is modeled in the schema but has no endpoint yet. **`PAID` is set only by the `sale.paid`
consumer** (`src/workers/salePaidConsumer.ts`), never by an HTTP handler — see
`docs/architecture.md` §4.1.

## Endpoints

| Route | Auth | Notes |
| --- | --- | --- |
| `POST /tenants` | none (bootstraps tenant + first owner) | the one unauthenticated write in this service |
| `GET /tenants/:id` | owner, own tenant | 404 on any other tenant |
| `POST /tenants/:id/attendants` | owner, own tenant | sets the payout MSISDN — owner-managed, never attendant-supplied (threat-model.md A7) |
| `POST /tenants/:id/rates` | owner, own tenant | basis points, `attendantId` omitted = tenant default |
| `POST /tenants/:id/products` | owner, own tenant | `unitPriceMinor` must be whole shillings (`% 100 == 0`) — M-Pesa cannot carry cents |
| `POST /sales` | any role, own tenant | **requires `Idempotency-Key`**; server recomputes the total from the product catalog, never trusts a client-sent price |
| `GET /sales/:id` | any role, own tenant | cross-tenant → 404, not 403 |
| `POST /sales/:id/pay` | any role, own tenant | body `{ customerMsisdn }`; calls Payments `POST /charges` with `tenantId` + phone; a timeout leaves the sale `UNPAID` with no `chargeId`, never a fabricated `FAILED` |
| `GET /health` `GET /ready` `GET /version` | none | golden path, `@tillflow/shared/health` |
| `POST /dev/tokens` | none, only if `DEV_AUTH_ENABLED=true` | mints a JWT for a known `(tenantId, externalAuthId)` — see "Auth scope" below |

## Auth scope (read before assuming this is a full login system)

G2 does not build an identity provider — that's out of scope (not in the Track A brief).
What's real and enforced: every route reads `tenantId`/`role` from a **verified JWT**
(`@fastify/jwt`), never from a path or body param, and role/tenant mismatches are rejected
(`src/plugins/auth.ts`). `POST /dev/tokens` mints that JWT directly for a user already in
the `users` table — a placeholder for wherever real sign-in eventually lives: swapping it
for real login only ever touches that one route, since everything downstream only reads
`request.principal`.

**`DEV_AUTH_ENABLED`** controls `/dev/tokens`, and is deliberately its own env var, not
`NODE_ENV`. The Dockerfile bakes `NODE_ENV=production` into every real image — correctly,
that's a Node/framework flag, not an environment name — but this capstone's one deployed
environment is also the *only* place k6, the game-day drill, or anyone testing the real
system can get a token at all, since there's no other login flow. Gating `/dev/tokens` on
`NODE_ENV` meant it was silently 404 the moment a real image ran (found while wiring k6
against a deployed target — `docs/scar-log.md`).

It **defaults to off** — opt-in (`=== 'true'`), not opt-out. `POST /tenants` is
intentionally unauthenticated (tenant #1 bootstrap) and accepts a caller-chosen
`ownerExternalAuthId`; an opt-out `/dev/tokens` default chains straight through it into a
credential-free owner JWT (found in PR #21 review before merge, never deployed —
`docs/scar-log.md`). The sandbox sets `DEV_AUTH_ENABLED=true` explicitly
(`infra/service-mesh.tf`, `pos` `service_env`) so the grant shows up in a Terraform diff.
Set it back to unset/`false` the day this deployment stops being sandbox-only.

## Invariants (`docs/adr/0006-idempotency-and-replay.md`, `docs/adr/0007`)

| ID | Invariant | Enforced by | Tested in |
| --- | --- | --- | --- |
| I1 | One sale per `(tenant, idempotency key)` | `UNIQUE(tenant_id, idempotency_key)` + stored first response; a genuine concurrent race recovers via the unique-violation catch, not just sequential retries | `test/idempotency.test.ts` |
| IDOR | Cross-tenant read → 404, never 403 | every query scoped `WHERE ... AND tenant_id = $principal` | `test/idor.test.ts` |
| — | `sale.paid` idempotent on `sale_id` | `sale_paid_events` dedupe table, guarded `UPDATE ... WHERE status != 'PAID'` | `test/salePaidConsumer.test.ts` |
| — | Timeout on the Payments call ⇒ stays `UNPAID`, never a fabricated `FAILED` | `PaymentsClient` returns `{outcome:'unknown'}` on any HTTP failure; POS never invents a status Payments didn't report | `test/saleFlow.test.ts` |

## Local development

```bash
cd services/pos
npm install            # from the repo root; this is an npm workspace
npm run build
npm test               # 16 tests, pg-mem-backed — no Postgres/Docker needed
npm run dev             # requires DATABASE_URL, JWT_SECRET, PAYMENTS_BASE_URL, SERVICE_TOKEN
```

### Running migrations against a real Postgres

```bash
ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npm run migrate
# creates the `pos` schema + devops-g1-pos-app role, prints a generated
# password once. Add --write-secret (+ AWS_REGION, AWS creds) to write it
# straight to Secrets Manager instead of printing it.
```

## What isn't proven yet

- **No real Postgres/RDS run** — all 16 tests run against `pg-mem` (loading the actual
  `migrations/*.sql`, not a hand-simplified schema), which does not model true
  cross-transaction locking. The I1 race-under-concurrency guarantee is correct by
  construction (a standard Postgres `UNIQUE` constraint + the unique-violation catch), but
  needs a real Postgres connection to verify empirically — see the note in
  `test/idempotency.test.ts`.
- **No deployed image** — `Dockerfile` is written (multi-stage, non-root, read-only rootfs,
  digest-pinned) but has not been built or run; no Docker is available in this environment.
- **Payments is a fake in every test** (`test/fakes/fakePaymentsClient.ts`) — integration
  with the real Payments API (Nebyat's track) is unproven until both services run together.

## Evidence

`evidence/product-pos/` — end-to-end sale demo, idempotency/IDOR test runs, and the exact
commands to reproduce both.
