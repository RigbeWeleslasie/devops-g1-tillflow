# k6 — capacity & resilience load tests

**DRI:** Rigbe (Reliability + operations)

Runs against the **deterministic M-Pesa stub** (`services/_shared/mpesa/stub-server`),
never the Daraja sandbox (sandbox is used only for a small contract test outside k6).

## Scenarios (built in G3)
```
k6/
├─ lib/            # shared: auth, tenant setup, sale->pay flow helpers
├─ smoke.js        # 1-5 VUs, 1 min — does it work at all
├─ baseline.js     # stepped ramp to find the knee; SLOs must hold
├─ spike.js        # sudden 10x for 2 min — recovery behavior
├─ soak.js         # >= 15 min at ~80% of baseline knee — leaks / queue growth
└─ results/        # *.json output (gitignored except .gitkeep)
```

## Thresholds (all scenarios)
- `http_req_failed` < 1%
- `http_req_duration` p95 < 500 ms
- `checks` > 99%
- Infra (from Grafana, correlated): CPU < 70%, memory < 75%, bounded SQS queue age

## Report (to `evidence/reliability-ops/` + `evidence/shared/`)
Highest sustained RPS where SLOs hold · bottleneck · headroom · cost assumption ·
caching before/after comparison · k6 JSON.

## Run
```bash
k6 run --out json=k6/results/baseline-$(date +%s).json k6/baseline.js \
  -e BASE_URL=https://<api-gw-url> -e MPESA_ADAPTER=fake
```
