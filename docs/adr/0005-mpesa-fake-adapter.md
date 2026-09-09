# ADR 0005 — M-Pesa adapter interface + deterministic fake

- **Status:** Accepted
- **Date:** 2026-09-09
- **DRI:** Nebyat (Payments + integrity)
- **Required proof:** interface in `services/_shared/`, contract test (fake vs sandbox),
  invariant tests using the fake

## Context

The Payments API owns all Daraja interaction. CI and k6 must never touch real money or
customer data and must be deterministic. We still need one real contract test against the
Daraja 3.0 sandbox to prove our wire format is correct.

## Decision

### One interface, two implementations

Define `MpesaAdapter` in `services/_shared/mpesa/` (language TBD in G1, interface shape fixed here):

```
interface MpesaAdapter {
  authToken(): Token                                  // OAuth client_credentials
  stkPush(req: StkPushRequest): StkPushAck             // { MerchantRequestID, CheckoutRequestID, ResponseCode }
  stkQuery(checkoutRequestId): StkQueryResult          // ResultCode / ResultDesc
  b2cPayment(req: B2CRequest): B2CAck                  // { ConversationID, OriginatorConversationID }
  // callbacks are HTTP endpoints on the Payments service, not adapter methods
}
```

| Impl | Where used | Behaviour |
| ---- | ---------- | --------- |
| `DarajaAdapter`  | `prod` runtime, one G-level contract test | Real HTTP to `sandbox.safaricom.co.ke`. Credentials from Secrets Manager `devops-g1/daraja`. |
| `FakeAdapter`    | all unit/integration/e2e tests, CI, k6 stub service | In-process (tests) or a tiny HTTP stub service (k6). Deterministic, no network. |

### FakeAdapter behaviour (deterministic, controllable)

Outcome is selected by the **amount's minor units** (or an explicit test header) so every
scenario is reproducible with no randomness:

| Trigger (amountMinor % 100, or `X-Fake-Scenario` header) | STK result |
| ------------------------------------------------------- | ---------- |
| `...00` (default)   | success — callback with `ResultCode 0` after configurable delay |
| `...01`             | customer cancelled — `ResultCode 1032` |
| `...02`             | insufficient funds — `ResultCode 1` |
| `...03`             | **timeout** — no ack within the HTTP timeout, callback never arrives (drives the "timeout is not a decline" drill) |
| `...04`             | ack OK, then **duplicate callback** delivered twice + out of order (drives replay drill) |
| `...05`             | ack OK, callback delayed > 60s (drives the Payments SLO / reconciliation path) |

- Callbacks are delivered by the fake POSTing to the Payments callback URL, so the full
  callback code path (dedupe, transition, ledger effect, trace) is exercised.
- B2C mirrors the same table for payout success/failure/timeout.
- The fake persists nothing; the Payments service persists state as it would in prod.
- A `seed` + fixed clock make delays deterministic in tests.

### Contract test

One test (`payments` integration suite, tagged `@contract`, run outside k6) performs a
single real sandbox STK Push with a tiny amount and asserts the response envelope matches
`StkPushAck`. Runs on a schedule / manual dispatch, not on every PR, and never in k6.

## Consequences

- `MPESA_ADAPTER=fake|daraja` env var selects the implementation; `prod` sets `daraja`,
  everything else `fake`.
- k6 runs against `services/_shared/mpesa/stub-server` deployed as a throwaway task or
  container; the Daraja sandbox is used only for the contract test.
- Adds a k6 stub deployment target to the infra scope for G3.
- The scenario table above is the single source of truth for failure-drill setup in
  `runbook.md` and `evidence/payments-integrity/`.
