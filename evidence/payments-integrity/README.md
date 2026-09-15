# evidence/payments-integrity

**DRI:** Nebyat — Payments + integrity ·
**Invariants:** [ADR 0006](../../docs/adr/0006-idempotency-and-replay.md) ·
**Adapter:** [ADR 0005](../../docs/adr/0005-mpesa-fake-adapter.md)

Every claim below is a command a reviewer can run. Screenshots earn nothing;
these are the reproductions.

## Prerequisites

```bash
node --version    # >= 22
npm ci            # from the repo root
```

No AWS, no database and no network are needed. Every test runs against
`pg-mem` loaded with the **real** `services/payments/migrations/*.sql`, and
against the deterministic `FakeAdapter` — so a constraint that would fail
against RDS fails here too.

## The invariants, and what proves each

Every command below is run **from the repo root** and its stated result is
the real output, not a summary. (Note `npm test -- --test-name-pattern=...`
does *not* filter — npm does not forward the flag past the glob. Invoke
`node --test` directly, as shown.)

| # | Invariant | Command | Result |
| - | --------- | ------- | ------ |
| **I2** | One charge per sale; a retry after a timeout never creates a second | `node --import tsx --test services/payments/test/charges.test.ts` | 22 tests, 0 failing |
| **I3** | One legal transition and one ledger effect per callback, at any order or repetition | `node --import tsx --test services/payments/test/callbacks.test.ts` | 12 tests, 0 failing |
| **I4** | One payout per (tenant, attendant, business day); re-running the close is a no-op | `node --import tsx --test services/commission/test/close.test.ts` | 18 tests, 0 failing |
| **I4** | …and one disbursement per ledger row | `node --import tsx --test services/payments/test/payouts.test.ts` | 18 tests, 0 failing |
| **I5** | A timeout leaves state `PENDING`, never `FAILED` | `node --import tsx --test services/payments/test/reconcile.test.ts` | 14 tests, 0 failing |
| — | The invariants as database constraints, independent of any handler | `node --import tsx --test services/payments/test/schema.test.ts` | 10 tests, 0 failing |

Run everything at once:

```bash
npm test --workspace=@tillflow/payments      # 80 tests
npm test --workspace=@tillflow/commission    # 38 tests
npm test --workspace=@tillflow/mpesa         # 32 tests
```

To run a single scenario, pass the pattern to `node` directly:

```bash
cd services/payments && node --import tsx --test \
  --test-name-pattern="I2 —" test/charges.test.ts    # 3 tests
```

## The three drills, executed

### 1. Uncertain payment — a timeout is not a decline

`services/payments/test/reconcile.test.ts`

```bash
node --import tsx --test services/payments/test/reconcile.test.ts   # 14 tests
```

Forces a Daraja timeout (scenario **KES 103**), keeps the charge `PENDING`,
then resolves it two ways and proves a retry cannot create a second charge:

- The push times out. `status=PENDING`, `checkout_request_id=NULL`,
  `last_push_error` records why. **No transition happens at all** — there is
  no code path from a timeout to `FAILED`.
- `POST /charges` again with the same `saleId` returns the *same* charge and
  **pushes nothing**. One push reached Daraja, not two; the customer is not
  prompted twice.
- The reconciler cannot query a charge with no `CheckoutRequestID`, so it
  counts the attempt and moves on. Past `RECONCILE_MAX_ATTEMPTS` it stops
  asking and surfaces the charge for an alert — it never auto-fails.
- When the late callback arrives, **adoption** re-associates it: same MSISDN,
  same amount, still `PENDING` with no id, created within 30 minutes, and
  **exactly one** candidate. Two in-flight charges for the same phone and
  amount are left for a human — crediting the wrong sale is worse than being
  stuck.

### 2. Callback replay and reorder

`services/payments/test/callbacks.test.ts`

```bash
node --import tsx --test services/payments/test/callbacks.test.ts   # 12 tests
```

- An identical redelivery lands on the **same** `callback_events` row and
  bumps `duplicate_count`. One row for three deliveries. That row *is* the
  "second span, zero writes" a trace points at.
- The **KES 104** scenario queues two copies of one success callback. Both
  land; one transition; one `outbox_events` row.
- Three charges delivered **last-first** with one replayed: each ends `PAID`
  exactly once, three callback rows, three outbox rows.
- A callback arriving after the charge is already terminal is recorded with
  `applied=false` and changes nothing. First resolution wins.

### 3. Daily close replay — duplicate disbursement = 0

`services/commission/test/close.test.ts`, `worker.test.ts`

```bash
node --import tsx --test services/commission/test/close.test.ts     # 18 tests
node --import tsx --test services/commission/test/worker.test.ts    # 10 tests
```

- Running the close twice: second run reports `ledgerRowsCreated=0`,
  `ledgerRowsExisting=1`, requests nothing.
- Ten runs, three concurrent runs, and three distinct EventBridge retry
  attempts: **one** ledger row, **one** payment, every time.
- A crash between computing the row and requesting the payout leaves it
  `COMPUTED` — never `FAILED` — and the next run completes it. One payment.
- The rate and MSISDN snapshotted at compute time survive a later change to
  both.

Against a live stack the same drill is two CLI runs:

```bash
npm run close --workspace=@tillflow/commission -- --day 2026-09-14
npm run close --workspace=@tillflow/commission -- --day 2026-09-14
# second run prints: replay: every ledger row already existed —
#                    nothing was recomputed, nothing re-paid
```

`--dry-run` prints what *would* be written without touching the ledger or
Payments; safe against prod.

## Money correctness

```bash
cd services/commission && node --import tsx --test \
  --test-name-pattern="rounding rule" test/close.test.ts            # 4 tests
```

The rule is `floor(total_minor × rate_bps / 10000)` **per sale, then summed**
([`@tillflow/shared/money`](../../services/_shared/ts/src/money.ts)). Flooring
an aggregate instead gives a different answer — three KES 100.50 sales at 5%
are **1506** per-sale but **1507** aggregate. That is why
`GET /internal/daily-close` returns per-sale amounts rather than a total.

M-Pesa bills whole shillings, so the ledger records three numbers: the exact
commission (`amount_minor`), what B2C can send (`payout_minor`, floored), and
the cents that stay with the tenant (`remainder_minor`). A test asserts
`payout + remainder == amount` — the truncation is auditable, not silent.
Both adapters **refuse** a fractional-shilling amount rather than rounding it.

## Callbacks we do not trust

| Abuse (threat-model.md) | Behaviour | Test |
| --- | --- | --- |
| **A1** Callback claims an amount we did not charge | Charge goes on **hold**; nothing applied. The hold then blocks *every* automatic path, including the genuine callback — a human decides | `callbacks.test.ts` "tampered amount" |
| **A2** Callback for a `CheckoutRequestID` we never issued | Stored with `matched=false`, applies nothing, still returns 200 | `callbacks.test.ts` "forged reference" |
| **A3** Two `POST /charges` racing for one sale | `UNIQUE(sale_id)`; five concurrent callers get one charge and one push | `charges.test.ts` "concurrent" |
| **A4** Re-trigger the close to double-pay | `UNIQUE(tenant, attendant, day)` + `ledger_id`-idempotent payout | `close.test.ts` |
| **A5** Change a rate mid-close | Rate snapshotted into the ledger row | `close.test.ts` "snapshots the rate" |
| **A7** B2C to an attacker's MSISDN | MSISDN comes from the attendant record via POS, never from the request | `internal.ts` contract |

## Boundary enforcement — commission never calls Daraja

Three independent layers, none of which relies on the others:

```bash
# 1. No dependency. @tillflow/mpesa is not in the worker's package.json,
#    and its Dockerfile does not install it.
grep -c mpesa services/commission/package.json          # 0
```

2. **Architecture** — the worker's only path to money is `POST /payouts` on
   the Payments API ([`paymentsClient.ts`](../../services/commission/src/clients/paymentsClient.ts)).
3. **IAM** — `ReadDarajaCredentials` in [`infra/data.tf`](../../infra/data.tf)
   is scoped to the `payments` task role alone. The commission task cannot
   read `devops-g1/daraja` even if the code tried.

## Wire-format proof, without spending real money

```bash
node --import tsx --test services/_shared/mpesa/test/daraja.test.ts  # 9 tests
```

`DarajaAdapter` runs against the `stub-server` over real HTTP on an ephemeral
port: OAuth token caching, STK push/query, B2C, a genuine socket timeout,
`X-Fake-Scenario` forwarding, and a 401 refresh. The stub speaks Daraja's
exact wire format from the same types the adapter sends, so the two cannot
drift.

The single `@contract` test against the real Daraja sandbox is **pending
credentials** — `devops-g1/daraja` currently holds
`PLACEHOLDER_SET_OUT_OF_BAND`. See "Still outstanding" below.

## Runtime proof — still outstanding

These need a deployed stack and are **not yet captured**:

- [ ] A distributed trace through sale → STK → callback → reconciliation
      (needs the ADOT sidecar healthy; PR #7's `health_check` extension fix)
- [ ] A scheduled commission run's trace
- [ ] The `@contract` test against the Daraja sandbox (needs real credentials
      in `devops-g1/daraja`)
- [ ] Slack alert firing and recovering for a held charge and for
      `chargesNeedingAttention` (G3, Reliability + operations)

The invariants above hold without any of these; what is missing is the
*runtime* evidence, not the correctness evidence.

## Commits

| Commit | What |
| --- | --- |
| `0f21b5b` | M-Pesa adapter interface + deterministic `FakeAdapter` |
| `5e6bc1f` | `DarajaAdapter`, fake-Daraja stub-server, shilling-keyed scenarios |
| `a910fc3` | Payments schema — invariants as constraints |
| `c436050` | `POST /charges` — I2, I5 |
| `e5f9fc2` | STK callback — I3 |
| `592269c` | Reconciliation and adoption — I5 |
| `9cd5ecd` | B2C payouts — I4, outbox relay |
| `25c15f4` | POS internal daily-close API (reviewed by @RigbeWeleslasie) |
| `f4e0365` | Commission daily close — I4 |
| `e13fec2` | Commission worker, clients, CLI, Dockerfile |
