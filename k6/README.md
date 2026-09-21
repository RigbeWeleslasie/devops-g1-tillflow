# k6 — capacity & resilience load tests

**DRI:** Rigbe (Reliability + operations)

Runs against the **deterministic M-Pesa stub** — a deployment-time config, not something
these scripts call directly. `MPESA_ADAPTER=fake` on the target `payments` deployment is
what routes STK/B2C to the fake adapter (ADR 0005); k6 just calls the real POS/Payments
API surface either way. Never point `BASE_URL` at a target running `MPESA_ADAPTER=daraja`.

## Scenarios

```
k6/
├─ lib/
│  ├─ config.js    # BASE_URL, thresholds, uniqueId() helper (no Node crypto in k6)
│  └─ pos.js        # bootstrapTenant() (setup-once) + createSale/paySale/getSale
├─ smoke.js        # 1-5 VUs, 1 min — does it work at all
├─ baseline.js     # stepped ramp to find the knee; SLOs must hold
├─ spike.js        # sudden 10x for 2 min — recovery behavior
├─ soak.js         # >= 15 min at ~80% of baseline knee — leaks / queue growth
└─ results/        # *.json output (gitignored except .gitkeep)
```

All four exercise the real sale → pay flow (`POST /sales` → `POST /sales/{id}/pay` →
`GET /sales/{id}`), each with its own `setup()` that bootstraps one fresh tenant +
attendant + whole-shilling-priced product, reused by every VU/iteration.

**Validated locally** against a real POS server + real Postgres 16 (not `pg-mem`) — all
four run end to end, 100% checks passing, 0% `http_req_failed`. Evidence:
[`evidence/reliability-ops/`](../evidence/reliability-ops/). **Not yet run** against a
real deployed AWS target — that needs `infra/observability.tf` (the canary/alarms/Grafana)
and an actual ECS deploy first (Meron's G3 work, in progress).

## Thresholds (all scenarios)
- `http_req_failed` < 1%
- `http_req_duration` p95 < 500 ms
- `checks` > 99%
- Infra (from Grafana, correlated): CPU < 70%, memory < 75%, bounded SQS queue age

## Constraint: the deployed edge throttles at 50 rps

The API Gateway stage in front of every deployed target allows **50 requests/second steady,
burst 100** (`infra/variables.tf` `api_throttle_rate` / `api_throttle_burst`, confirmed on the
live `$default` stage via `aws apigatewayv2 get-stage`). It is a blunt cost/DoS guard, and it
matters here in three ways:

- **A run through the edge cannot measure more than 50 rps.** Anything above it comes back
  `429`, which k6 counts as `http_req_failed`. A "knee" found by `baseline.js` at that point is
  the throttle, not a capacity limit of the service — reporting it as one would be wrong.
- **It is shared with the uptime canary.** The probe goes through the same stage, so a load
  test that saturates it fails `devops-g1-uptime-probe-failing`, pages Slack, and counts as
  downtime in the uptime figure (2026-09-20 23:22–23:31 Nairobi: 10 minutes of `429`, see
  `docs/scar-log.md`). Tell the alert channel before running.
- **Where each scenario crosses it.** Measured on a `smoke.js`-shaped iteration (three
  requests, `sleep(1)`): about 1.1 req/s per VU (`k6-fullflow-run.md`: 349 requests, ~5.6 req/s
  at 5 VUs), so the limit is reached near 45 VUs. `soak.js` at its default 15 VUs (~17 rps)
  stays under it. `baseline.js` ramps 20 VUs per step and `spike.js` peaks at 100, so both
  cross it. These are estimates from one run, not measurements of each script.

Two honest ways forward, and it is a decision, not a default: raise the throttle for the test
window (Terraform, Platform's file, a production change to revert afterwards), or run as-is
and report the result as *"edge-limited at 50 rps"* rather than as service capacity.

## Report (to `evidence/reliability-ops/` + `evidence/shared/`)
Highest sustained RPS where SLOs hold · bottleneck · headroom · cost assumption ·
caching before/after comparison · k6 JSON. **Not done yet** — needs a real run against a
real target; see `evidence/reliability-ops/README.md`'s "What this does NOT prove yet".

## Run

Against a real deployed target (the actual G3 use):
```bash
k6 run --out json=k6/results/baseline-$(date +%s).json k6/baseline.js \
  -e BASE_URL=https://<api-gw-url>
```

Locally, against a bare server with no API Gateway/ALB edge in front (no path prefix):
```bash
k6 run k6/smoke.js -e BASE_URL=http://localhost:8080 -e POS_PREFIX=
```

`baseline.js`/`spike.js`/`soak.js` take extra `-e` overrides for their ramp shape —
`STEP_VUS`/`STEP_DURATION`/`STEPS`, `BASELINE_VUS`, `SOAK_VUS`/`SOAK_DURATION`
respectively. Defaults are documented in each script's header comment. `SOAK_VUS`
specifically has no way to default correctly until a real `baseline.js` run identifies the
knee — override it once that number exists.
