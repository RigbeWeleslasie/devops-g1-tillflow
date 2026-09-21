# k6 against the full deployed flow — all four services live

**Executed:** 2026-09-21 06:42 UTC. Added by Meron (Platform). The load model and the
capacity analysis are Reliability's (`docs/ownership.md` Area 4); this is the run data
and what it exposed.

Supersedes the caveat in [`k6-deployed-run.md`](k6-deployed-run.md), which had to record
that `POST /sales/{id}/pay` returned `202 Accepted` with **nothing behind it** because
`payments` sat at `desiredCount 0`. All four services are now deployed, so the pay call
reaches a real Payments service that creates a real charge.

## Result — all three thresholds green

| Threshold | Target | Payments down (19 Sep) | **Payments live (21 Sep)** |
| --- | --- | --- | --- |
| `checks` | `rate>0.99` | 100.00% (575/575) | **100.00%** (575/575) |
| `http_req_duration` | `p(95)<500ms` | 348.00 ms | **285.91 ms** |
| `http_req_failed` | `rate<0.01` | 0.00% | **0.00%** |

115 iterations, 349 requests, ~5.6 req/s at 5 VUs.

**Adding a real service hop cost nothing measurable.** p95 went *down*, not up — the
earlier figure was a same-shape run against a shorter path, so the difference is run-to-run
variance rather than the cost of Payments. That is the useful capacity finding here: at
this level the bottleneck is not the POS→Payments call.

## What the run exposed, which is the more interesting part

`payments_command_total` never appeared in CloudWatch. `payments_reconcile_total` did,
with a single label:

```
payments_reconcile_total{outcome=unqueryable, OTelLib=@tillflow/payments}
```

The service logs say exactly why:

```
reconcile: charge has no CheckoutRequestID (push timed out);
awaiting a late callback or an operator
```

Real charges were created against real sales — the log lines carry genuine `chargeId` and
`saleId` pairs. The STK push to Daraja then timed out, because the sandbox credentials in
`devops-g1/daraja` are unset (`docs/gates.md` G2 records this as outstanding).

**This is the system behaving correctly, not failing.** `docs/architecture.md` §1 states
the invariant as *"a timeout is not a decline — an uncertain payment stays `pending` and
is resolved by transaction query / reconciliation, never by guessing."* That is precisely
what happened, under load, 115 times:

- charges were created and held, not marked FAILED
- the reconciler picked them up rather than leaving them orphaned
- the outcome was labelled `unqueryable` — which
  `evidence/payments-integrity/metrics.md` classifies as **good**, not budget burn, with
  `needs_attention` reserved for "we have stopped finding out what happened"

So this run is evidence for the uncertain-payment path holding under concurrency, which is
harder to produce deliberately than a clean happy path.

## Consequence for the burn-rate alarms

The POS burn-rate alarms in this PR bind to `pos_sale_write_total`, which is emitting and
whose dimensions were verified against live CloudWatch before they were written.

The Payments equivalents are **not** in this PR. The mapping exists
(`evidence/payments-integrity/metrics.md`, #36) and the alarms are mechanical to write
from it, but `payments_command_total` has never been emitted, so its dimension set cannot
be verified. Writing alarms against an unverified dimension set is what produces an alarm
sitting in `INSUFFICIENT_DATA` forever while looking green in Terraform — the exact
failure this PR exists to avoid.

**Unblocked by:** working Daraja sandbox credentials in `devops-g1/daraja` (Area 2,
Nebyat). One k6 run after that populates the series and the alarms can be added and
verified in the same change.

## A bug this run depended on being fixed first

`payments` was deployed but returning 503 on every DB-backed route. Its `database_url`
secret was missing `sslmode`, and `rds.force_ssl=1` refused every connection:

```
no pg_hba.conf entry for host "10.20.144.111",
user "devops-g1-payments-app", database "tillflow", no encryption
   msg: "outbox relay tick failed"
```

Same root cause as the POS bug fixed in #30/#31: the code fix landed, but
`buildAppDatabaseUrl` only writes that secret when it **creates** the role, so an existing
deployment never receives the corrected URL. The secret was patched by hand and the
service redeployed; the relay went from erroring once per second to zero errors.

That mattered beyond the 503: the outbox relay is what publishes `sale.paid`, so the money
path could not have completed regardless of Daraja.

**The migration's inability to repair an existing deployment is worth a runbook entry
before G4's restore drill** — a restore that recreates a service without recreating its
role lands in the same state.

## Reproduce

```bash
k6 run --out json=k6/results/smoke-fullflow-$(date -u +%Y%m%dT%H%M%SZ).json \
  --summary-export k6/results/smoke-fullflow-summary.json \
  k6/smoke.js -e BASE_URL=https://k0lzgyvn1i.execute-api.us-east-1.amazonaws.com
```

Strip `setup_data` before committing the summary — it contains a live owner JWT. See
[`k6-deployed-run.md`](k6-deployed-run.md) for the one-liner and why.
