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

Selected by `amountMinor % 100`, or by an explicit `X-Fake-Scenario` header that the
Payments service forwards as `scenarioHint`.

| Cents | Scenario | STK result | What it drives |
| --- | --- | --- | --- |
| `00` | `success` | callback `ResultCode 0` | happy path |
| `01` | `cancelled` | `ResultCode 1032` | genuine business decline |
| `02` | `insufficient_funds` | `ResultCode 1` | genuine business decline |
| `03` | `timeout` | **no ack, no callback**; `MpesaTimeoutError` | "a timeout is not a decline" — I5, reconciler |
| `04` | `duplicate_callback` | ack OK; the same success callback **twice** | replay / reorder — I3 |
| `05` | `delayed_callback` | ack OK; callback lands after 61 s | Payments SLO / reconciliation window |

B2C mirrors the same table (`01`/`02` both mean the business balance is short — there is no
"customer cancelled" on a payout).

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
