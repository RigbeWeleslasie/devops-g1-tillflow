# k6 run against the wrong branch — full flow, not POS-only

**Not the POS-capacity number.** See `docs/scar-log.md` (2026-09-29) for the full story: the
run meant to use `feat/g3-k6-pos-capacity`'s `SKIP_PAY=true` ran on `main` instead, which has
neither that switch nor the `env_overrides` input, so the unmodified sale → pay → get flow
executed under the temporarily-raised (1000 rps / 2000 burst) API Gateway throttle.

GitHub Actions run **#4** (`36471199547`), branch `main`, `k6/baseline.js`, 12m24s,
2026-09-29.

## Result — all thresholds pass except latency, and for a real reason

| Threshold | Target | Result |
| --- | --- | --- |
| `checks` | `rate>0.99` | **100.00%** (161,152 / 161,152) |
| `http_req_duration` | `p(95)<500ms` | **650.86ms** — breached |
| `http_req_failed` | `rate<0.01` | **0.00%** |

40,288 iterations, 120,868 requests, stepped 20→100 VUs. `checks_total` (161,152) is exactly
4 × iterations — `POST /sales`, the `UNPAID` status check, `POST /sales/{id}/pay`, and
`GET /sales/{id}` all ran every time, confirming the pay step was **not** skipped.

## What this accidentally proves

- **The system held together under 40,287 real `/pay` calls in 12 minutes, at up to 100
  VUs, with zero failures and zero crashes.** That's real resilience evidence, just not the
  evidence this run was meant to produce.
- **The latency breach is explained, not mysterious:** `g3-money-path-trace.md` already
  showed a single `/pay` call takes ~1.5s because POS waits synchronously on Payments'
  real, failing OAuth call to Daraja. A p95 of 650ms under load (better than the single-call
  worst case, likely from connection reuse / OAuth failing faster under load) is consistent
  with that, not with a POS-side bottleneck.

## What this does not prove

- **Not a POS capacity number.** The bottleneck measured here is Daraja's OAuth endpoint via
  Payments, not POS or its database. `k6-baseline-run.md`'s edge-limited reading and this
  run's provider-limited reading are two different, non-substitutable findings — neither is
  "what POS can hold."
- **This is not a load test that should have happened this way.** `k6/README.md` is explicit
  that this suite must never point real traffic at the actual M-Pesa provider. It happened
  here by branch-selection mistake, not by design; recorded honestly rather than quietly
  discarded.

The real POS-capacity re-run, on the correct branch with `SKIP_PAY=true`, is still open.
