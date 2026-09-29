# G4/G5 — restore reconciliation (runbook §2.5 step 4), executed on the live system

**DRI:** Nebyat (Payments) · complements Meron's restore drill
[`evidence/platform-delivery/g4-restore-drill.md`](../platform-delivery/g4-restore-drill.md),
which restored the DB and measured RTO but recorded reconciliation as *designed but not
executed* because `payments` was at `desiredCount 0` and the Daraja target was unset.

Both blockers are now gone: `payments` is live (task def 32) and pointed at the M-Pesa stub
(`DARAJA_BASE_URL=localhost:9090`), so `stkQuery` answers. This records the reconciliation
step — asking the provider for the authoritative state of `PENDING` charges — executed
against the deployed system.

## What runbook §2.5 step 4 asks for

> For every `PENDING`/ambiguous charge in the restored data, run `stkQuery` against the
> provider to get the authoritative state. The provider is the source of truth for money moved.

The reconciler (`POST /admin/reconcile` → `services/payments/src/services/reconcileService.ts`)
is that step. Two branches, both now shown on the live edge:

1. **Queryable charge → ask the provider, apply its answer.** Proven live by the drill 2.2
   trace (`drills/g4-2.2-callback-replay-20260929T081929Z.md`): the confirm-before-PAID path
   issued `POST http://localhost:9090/mpesa/stkpushquery/v1/query` and applied the provider's
   `SUCCESS` — a `PENDING → PAID` transition driven by the provider's own answer, over the same
   `stkQuery` call the reconciler uses. Unit coverage: `services/payments/test/reconcile.test.ts`.
2. **Unqueryable charge → never invent a result.** Proven live by
   [`drills/g4-2.1-step3-deployed-20260929T121850Z.md`](drills/g4-2.1-step3-deployed-20260929T121850Z.md):
   a timed-out charge with no CheckoutRequestID was queried 12 times, never auto-failed, and
   surfaced for a human still `PENDING`. This is the case a restore is most exposed to — a
   charge we can't ask about — and the reconciler refuses to guess it.

## The caveat, stated plainly

**The stub is stateless, so this proves the mechanism against the live system, not a faithful
"provider outlived our backup" scenario.** A true restore-reconciliation risk is that the
provider settled a payment *after* the backup point, so a charge reads `PENDING` in restored
data while the provider knows it as `PAID`. The stub has no memory across a restore and answers
`stkQuery` deterministically by CheckoutRequestID, so it cannot reproduce that divergence. What
is proven here is that the reconciler **runs against the live deployed system, queries the
provider for `PENDING` charges, applies a terminal answer, and never fabricates one** — the
mechanism runbook §2.5 step 4 depends on. Reproducing the divergence faithfully needs a
stateful sandbox or the real Daraja sandbox with credentials, which remains out of scope.
