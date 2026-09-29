# k6 baseline — POS-only capacity, isolated from the edge throttle and Payments

**The real POS capacity number** `docs/ownership.md`'s "highest sustained RPS where SLOs
hold" asks for, and what `k6-baseline-run.md` (2026-09-23) explicitly could not give —
that run measured the API Gateway's 50 rps throttle, not POS. This run removes both
confounds at once: the throttle was temporarily raised for the run window, and
`SKIP_PAY=true` (`k6/lib/config.js`) drops the `/pay` step so the load never touches
Payments or Daraja.

**Executed:** 2026-09-29, 12:53–13:12 UTC. GitHub Actions **k6 load**, branch `main`,
scenario `baseline`, `env_overrides: SKIP_PAY=true STEP_VUS=20 STEPS=8` — eight 2-minute
steps, 20→160 VUs, then ramp down. Raw summary:
[`k6-baseline-pos-only-capacity.json`](k6-baseline-pos-only-capacity.json) (`ownerToken`
redacted, same pattern as every other committed k6 summary in this directory).

## Result — all three thresholds pass, even at 160 VUs

| Threshold | Target | Result |
| --- | --- | --- |
| `checks` | `rate>0.99` | **100.00%** (358,497 / 358,497) |
| `http_req_duration` | `p(95)<500ms` | **291.45 ms** |
| `http_req_failed` | `rate<0.01` | **0.00%** (0 / 239,002) |

239,002 requests, 119,499 iterations, **~221 req/s** sustained average across the full
ramp (including both 2-minute ramps). `vus_max` 160.

## The knee was not found in this range

Every threshold held cleanly through the highest step tested (160 VUs). That means POS's
real capacity ceiling sits **above** what this run exercised — this establishes a floor
(≥160 VUs / ~221 req/s with full SLO compliance), not the ceiling itself. Finding the
actual knee would need a further run with a higher `STEPS`/`STEP_VUS`; not done here, and
not claimed.

## How the two confounds were actually removed, not just declared removed

- **Edge throttle:** raised from 50/100 to 1000/2000 rps/burst
  (`aws_apigatewayv2_stage.default`, via `terraform apply -target=...` — `-target` used
  deliberately after an earlier attempt without it registered unrelated
  `service_images={}` task-definition drift, `docs/scar-log.md` 2026-09-29) for the
  duration of the run only, and verified live (`aws apigatewayv2 get-stage`) both
  immediately after raising and immediately after reverting back to 50/100.
- **Payments/Daraja:** confirmed **zero** `/pay` or `/callbacks/stk` traffic reached
  Payments for the entire run window, checked directly against X-Ray
  (`aws xray get-trace-summaries`, `service("payments")`, grouped by URL path) — not
  inferred from the k6 side. Payments saw only its routine canary probes (40 `/health`,
  162 `/ready`) throughout. This is the verification the two earlier attempts on
  2026-09-29 lacked, which is why they went to the real provider by mistake
  (`docs/scar-log.md`).

## What this does and does not prove

- **Proves:** POS itself, backed by real RDS, holds ~221 req/s sustained with p95 under
  300ms and zero failures at up to 160 concurrent VUs — a real capacity floor, not an
  edge-limited or provider-limited number.
- **Does not prove:** the actual knee (this run never found it), or POS's behavior under
  the full sale→pay flow at this load (that still crosses into Payments/Daraja territory,
  which is edge-limited by design per `docs/g4-plan.md` §7's decision).
- **Supersedes, doesn't replace,** `k6-baseline-run.md` and `k6-spike-run.md` — those
  documented the edge-limited reading honestly; this documents what lies beyond it.
