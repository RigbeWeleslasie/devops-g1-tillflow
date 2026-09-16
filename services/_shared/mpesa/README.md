# @tillflow/mpesa — M-Pesa adapter

**DRI:** Nebyat (Payments + integrity) · co-owned path with Meron per `CODEOWNERS` ·
**Decision:** [ADR 0005](../../../docs/adr/0005-mpesa-fake-adapter.md)

One interface, two implementations. The Payments service programs against
`MpesaAdapter` and never learns which one it got.

| Implementation | Where | Behaviour |
| --- | --- | --- |
| `FakeAdapter` | every unit/integration test, CI, k6 stub-server | In-process, deterministic, persists nothing. Outcome from the scenario table. |
| `DarajaAdapter` | `prod` runtime, one `@contract` test | Real HTTPS to `sandbox.safaricom.co.ke`. Credentials from Secrets Manager `devops-g1/daraja`. |

`MPESA_ADAPTER=fake|daraja` selects at startup. Everything except `prod` is `fake`.

## Scenario table (single source of truth for every failure drill)

Selected by the **last two digits of the shilling amount** (`KES % 100`), or by an explicit
`X-Fake-Scenario` header that the Payments service forwards as `scenarioHint`. Shillings,
not cents: Daraja only accepts whole-shilling amounts, so a cents-based key could never
reach a fake Daraja over the wire. KES 103 is a timeout whether the fake is in-process or
behind the stub-server.

| KES ends in | Example | Scenario | STK result | What it drives |
| --- | --- | --- | --- | --- |
| `00` | KES 100, 1 000 | `success` | callback `ResultCode 0` | happy path |
| `01` | KES 101 | `cancelled` | `ResultCode 1032` | genuine business decline |
| `02` | KES 102 | `insufficient_funds` | `ResultCode 1` | genuine business decline |
| `03` | KES 103 | `timeout` | **no ack, no callback**; `MpesaTimeoutError` | "a timeout is not a decline" — I5, reconciler |
| `04` | KES 104 | `duplicate_callback` | ack OK; the same success callback **twice** | replay / reorder — I3 |
| `05` | KES 105 | `delayed_callback` | ack OK; callback lands after 61 s | Payments SLO / reconciliation window |
| anything else | KES 250 | `success` | — | ordinary money |

B2C mirrors the same table (`01`/`02` both mean the business balance is short — there is no
"customer cancelled" on a payout).

**Whole shillings only.** Both adapters refuse a fractional-shilling amount (`KES 2.50`)
rather than rounding it. The fake refuses exactly what the real adapter refuses, so a test
cannot pass with an amount prod would reject. This is a product constraint: **product prices
must be whole shillings** (`unit_price_minor % 100 == 0`).

## The stub-server is a fake Daraja

`npm run stub` (or `node dist/stub-server.js`, `PORT=9090`) serves Daraja's real endpoints
(`/oauth/v1/generate`, `/mpesa/stkpush/v1/processrequest`, `/mpesa/stkpushquery/v1/query`,
`/mpesa/b2c/v3/paymentrequest`) in Daraja's exact wire format, backed by `FakeAdapter`.

Under k6 the Payments service runs with `MPESA_ADAPTER=daraja` and `DARAJA_BASE_URL` pointed
at the stub — so the **real `DarajaAdapter`** HTTP path (OAuth, timeouts, callback delivery
over the network) is what gets load-tested, not an in-process shortcut. Callbacks
auto-deliver on a timer; a `timeout` scenario holds the socket open past the client's timeout
and then drops it, so the client experiences a real network timeout.

`test/daraja.test.ts` runs `DarajaAdapter` against the stub on an ephemeral port and proves
the two agree on the wire format. The one `@contract` test against the real sandbox then only
has to confirm the sandbox agrees with the stub.

## Callbacks are pulled, not pushed

The fake never fires a callback on its own. A push or payout *queues* what its scenario
calls for; the test decides when it lands, in what order, and how often:

```ts
const fake = new FakeAdapter({ clock: () => now, seed: 1, deliver: (cb) => app.inject({ method: 'POST', url: cb.url, payload: cb.body }) });

await fake.stkPush({ amountMinor: 25_004, ... });     // duplicate_callback
await fake.deliverPending({ order: 'reverse' });       // reorder drill
await fake.redeliver(fake.deliveredCallbacks()[0]);    // replay drill
```

`deliver` is injected: a unit test hands in Fastify's `inject` (no socket), the k6
stub-server hands in `fetch`. Either way the Payments service runs its real callback
route — dedupe, guarded transition, outbox row, trace.

## The timeout case is modelled honestly

A `timeout` push **throws** (the caller hears nothing) **and** records the attempt
internally — because the dangerous real-world case is that the request reached Daraja and
only the response was lost. The test then decides what actually happened:

```ts
const [id] = fake.unresolvedTimeouts();
await fake.stkQuery(id);                 // { status: 'pending' } — Daraja's "being processed"
fake.resolveTimeout(id, 'success');      // now query answers, and the late callback is queued
```

That is what lets the uncertain-payment drill prove the reconciler resolves via query, and
that a late callback arriving *after* query-resolution is a no-op.

## Deviations from ADR 0005

- `authToken()` is internal to `DarajaAdapter`, not on the interface. The fake has nothing
  to authenticate against, and the Payments service has no reason to hold a token.
- `stkQuery` returns `{ status: 'pending' }` for an in-flight push instead of throwing, so
  the reconciler's "ask again later" path is a value, not an exception.
