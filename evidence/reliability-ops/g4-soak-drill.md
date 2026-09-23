# 2.9 Resource saturation — k6 soak against the deployed target

**Executed:** 2026-09-22, 18:21–18:38 UTC (GitHub Actions run
[`k6-load#1`](https://github.com/RigbeWeleslasie/devops-g1-tillflow/actions/runs/35766661923),
commit `aa59eae`, branch `main`). Triggered via `.github/workflows/k6.yml`
`workflow_dispatch` (`scenario: soak`, default `SOAK_VUS=15`/`SOAK_DURATION=15m`), against
the live API Gateway edge that the workflow resolved automatically. Total job duration
17m18s; the job reported `success`.

`pos`, `pos-worker` and `payments` were all confirmed deployed before the run — this is
the run that was blocked earlier in `docs/g4-plan.md` on `payments` going live, and is now
unblocked.

## Result — all three thresholds green

| Threshold | Target | Result |
| --- | --- | --- |
| `checks` | `rate>0.99` | **100.00%** (38,685 / 38,685) |
| `http_req_duration` | `p(95)<500ms` | **61.06 ms** |
| `http_req_failed` | `rate<0.01` | **0.00%** (0 / 38,689) |

12,895 iterations (sale → pay → get), 38,689 HTTP requests, ramp 1m → 15 VUs → hold 15m →
ramp down 1m. Average throughput over the full run (including both ramps) was **37.9
req/s**; modeling the steady 15-VU hold alone (3 requests/iteration, ~1.12s/iteration)
gives **~40 req/s** sustained — under the live 50 rps API Gateway throttle
(`docs/scar-log.md`, `k6/README.md`), which is exactly why the run saw zero 429s and zero
failures. This is the soak's job: find a slow leak or queue growth at a load the edge can
actually sustain, not push past the throttle — that's what baseline/spike are for
(see below).

Raw summary: [`k6-soak-run-summary.json`](k6-soak-run-summary.json) (the `ownerToken` in
`setup_data` is redacted before commit, same as `k6-smoke-local-validation.json` — it's a
real JWT signed by the live `/dev/tokens` endpoint for this run, not a fixture).

## What this does and does not prove

- **No leak or backlog growth under sustained load at ~40 rps for 15 minutes** — the whole
  point of a soak over a baseline. Latency stayed flat (p95 61ms vs p90 53ms, no drift
  visible in the aggregate), and every single request succeeded.
- **Grafana correlation — confirmed, screenshot attached.**
  [`g4-soak-grafana-correlation.png`](g4-soak-grafana-correlation.png), `devops-g1-slo-dashboard`,
  time range 2026-09-22 21:10–21:50 Nairobi/EAT (18:10–18:50 UTC), which brackets the
  18:21–18:38 UTC run with margin on both sides:
  - **POS target latency p95** — flat at 0 outside the run window, jumps to a ~50ms peak at
    ramp-up, settles to a ~30–40ms plateau for the hold, drops back to 0 after ramp-down.
    Same order of magnitude as the k6-side p95 (61ms) — Grafana's bucketed aggregation
    doesn't match k6's raw percentile exactly, but both agree: fast and flat, no drift.
  - **POS ECS CPU / memory** — CPU rises from near-idle to a ~20–25% plateau, memory from
    ~10% to ~12%, both for the exact duration of the hold, both drop back down after. Real,
    visible load — and nowhere near the 70%/75% alarm thresholds (`docs/runbook.md`), which
    is consistent with the soak deliberately staying under the edge throttle rather than
    pushing POS's own resource ceiling.
  - **sale-events queue age** — flat at 0 for the entire window. No backlog, matching the
    "no leak or queue growth" claim above with an actual chart, not just an inference from
    k6's own numbers.
  - **Fast/slow burn panels** (same screenshot) — flat at 0 against their 14.4×/6× red
    threshold lines, consistent with zero failed writes during the run.
- **This is not the capacity envelope.** A soak alone doesn't find "the highest sustained
  RPS" `docs/ownership.md` asks for — that's `baseline.js`'s job (a stepped ramp to find
  the knee). Soak and baseline are complementary, not substitutes; see
  `docs/g4-edge-throttle-caveat` for why baseline and spike are expected to hit the edge
  throttle rather than POS's own limit.

## Recovery signal / proof (G4)

Runbook §2.9's proof line asks for exactly this: "exercised as part of the k6 soak run and
the capacity analysis" — done, for the soak half. The full k6 envelope (baseline + spike,
both expected to be edge-limited rather than POS-limited) is tracked separately and is
what closes G3's "k6 envelope" gap, not just this drill.
