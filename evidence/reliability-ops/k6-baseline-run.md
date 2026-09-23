# k6 baseline — stepped ramp against the deployed target, edge-limited

**Executed:** 2026-09-23, GitHub Actions run
[`k6-load#2`](https://github.com/RigbeWeleslasie/devops-g1-tillflow/actions/runs/35901601810),
`scenario: baseline`, default `STEP_VUS=20`/`STEPS=5`/`STEP_DURATION=2m` — six 2-minute
stages (20/40/60/80/100 VUs, then a 2m ramp-down), 12 minutes total. Job exited non-zero
(`Process completed with exit code 99`) because `baseline.js`'s thresholds breached — this
was the expected result, not a failed run; see the decision below.

## Result — two of three thresholds breached, by design

| Threshold | Target | Result |
| --- | --- | --- |
| `checks` | `rate>0.99` | **32.15%** — breached |
| `http_req_duration` | `p(95)<500ms` | **61.38 ms** — held |
| `http_req_failed` | `rate<0.01` | **66.12%** — breached |

Totals over the full 12-minute ramp: 100,902 HTTP requests (140 req/s attempted), 63,514
iterations (88/s), `vus_max` 100. Per-check breakdown:

| Check | Pass rate |
| --- | --- |
| `POST /sales -> 201` | 29% (18,692 / 63,514) |
| `POST /sales/{id}/pay -> 202` | 41% (7,796 / 18,688) |
| `GET /sales/{id} -> 200` | 41% (7,693 / 18,688) |

## Reading this as edge-limited, not POS-limited — the decision this run was meant to test

Per `docs/g4-plan.md` §7 (2026-09-22 decision): run `baseline.js` as-is against the live 50
rps API Gateway throttle rather than asking Meron to raise it for a test window, and report
the result as edge-limited. This run backs that reading directly, not just by the numbers
lining up:

- **Successful requests stayed fast under the same load that was failing two-thirds of the
  time.** `http_req_duration{expected_response:true}` averaged 53ms (p95 90ms) — barely
  above the soak run's clean-path 39ms average (`k6-soak-run-summary.json`). A capacity
  wall inside POS (CPU, DB connections, a saturated worker) would show requests getting
  *slower* as load rose, then failing. Here the requests that got through were never slow;
  the ones that didn't get through failed immediately. That is the signature of a gate
  (API Gateway's throttle bucket) rejecting requests outright, not a service buckling
  under load.
- **The overall failure rate (66%) is close to what 100 VUs of demand against a 50 rps cap
  predicts.** At full ramp (100 VUs), modeled demand is roughly 100 × 1.1 req/s ≈ 110 req/s
  (the per-VU rate the soak run established) against a 50 rps cap — a large majority of
  requests should be rejected, which is what happened. The two lower steps (20, 40 VUs,
  modeled ~22–44 req/s) sit close to or under the cap and are where most of the 32%
  aggregate check-pass rate is likely concentrated, but this run's summary is aggregated
  over the whole ramp, not broken out per step — a precise per-step knee (e.g. "the 40→60
  VU step is exactly where it turns over") would need the raw per-request JSON with
  timestamps, which was not pulled for this run. The aggregate result is enough to support
  "edge-limited," not enough to name the exact VU where it turns over.

## What this does and does not prove

- **Does not find POS's own capacity ceiling.** That was the known tradeoff of the
  2026-09-22 decision — this run measures the API Gateway's throttle, not the service
  behind it. The soak run (`g4-soak-drill.md`) is the evidence for POS's behavior *under*
  the throttle: clean, flat-latency, zero-failure at ~40 req/s sustained for 15 minutes.
- **Does support "no cascading failure under overload."** Latency for successful requests
  did not degrade under 100 VUs of pressure — nothing timed out slowly, connections did not
  pile up, the service kept responding fast to whatever got past the gateway.
- **Not a repeat of this run with the throttle raised.** Per the decision, that is out of
  scope for this envelope; if a real POS capacity number is ever needed, it requires a
  coordinated, reverted Terraform change to the throttle, run separately.
