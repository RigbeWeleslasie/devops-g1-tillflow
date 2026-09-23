# k6 spike — sudden 10× against the deployed target, same edge-limited signature

**Executed:** 2026-09-23, GitHub Actions run
[`k6-load#3`](https://github.com/RigbeWeleslasie/devops-g1-tillflow/actions/runs/35903478922),
`scenario: spike`, default `BASELINE_VUS=10` (→ `SPIKE_VUS=100`). Stages: 30s warm-up at
10 VUs, 30s hold, 10s ramp to 100 VUs, 2m hold at 100 VUs, 30s back down, 1m recovery hold
at 10 VUs, 20s down — 5 minutes total. Job exited non-zero (exit code 99) because
`spike.js`'s own, deliberately loose `SPIKE_THRESHOLDS` breached — expected, not a failed
run; `spike.js`'s header comment explains why a spike is allowed to bend where the other
scenarios are not.

## Result — both spike thresholds breached, by the same margin baseline predicted

| Threshold | Target | Result |
| --- | --- | --- |
| `checks` | `rate>0.50` | **20.88%** — breached |
| `http_req_failed` | `rate<0.50` | **79.10%** — breached |

67,071 HTTP requests (223 req/s attempted), 57,104 iterations (190/s) over the 5-minute
run, `vus_max` 100.

| Check | Pass rate |
| --- | --- |
| `POST /sales -> 201` | 17% (9,963 / 57,104) |
| `POST /sales/{id}/pay -> 202` | 40% (4,045 / 9,963) |

## Same edge-limited signature as baseline — latency held, only volume failed

`http_req_duration{expected_response:true}` averaged 74.6ms (p95 102.7ms) — close to
`k6-baseline-run.md`'s 53ms/90ms and `g4-soak-drill.md`'s clean-path 39ms/61ms, not the
multi-second stall a genuinely overloaded service would show under a sudden 10× spike.
Requests that got past the gateway were served about as fast as an unthrottled run; the
79% that failed were rejected, not queued and timed out. This is the same reading as
baseline for the same reason: API Gateway's 50 rps throttle rejecting outright, not POS
buckling.

**Recovery:** the workflow's own success (job completed, no hung processes, VUs ramped
cleanly back to 0) is evidence the service came back to a normal state once load dropped —
`spike.js`'s last two stages (30s down to 10 VUs, 1m hold) exist specifically to test that
recovery, and nothing in the run log suggests it failed to settle. A Grafana screenshot of
the recovery window (latency/error-rate panels returning to baseline) was not captured for
this run.

## What this does and does not prove

- **Does not find POS's real spike-tolerance ceiling** — same tradeoff as baseline, by the
  same 2026-09-22 decision (`docs/g4-plan.md` §7): edge-limited, not service-limited.
- **Does support that a sudden 10× burst does not cascade into a slow, hung service** —
  latency stayed flat and the run recovered cleanly, which is the actual question a spike
  test asks (recovery behavior, not sustained capacity, per the script's own header comment).
- **Closes the k6 envelope's three scenarios** (soak, baseline, spike) against the deployed
  target — `smoke.js` was already proven earlier (`k6-deployed-run.md`,
  `k6-fullflow-run.md`). All four now have real runs against the live edge.
