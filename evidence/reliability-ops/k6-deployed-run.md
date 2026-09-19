# k6 against the deployed target — G3 "k6 envelope"

Added by Meron (Platform). The load model, thresholds and capacity analysis are
Reliability's (`docs/ownership.md` Area 4); this records the run against real AWS.

Distinct from `k6-smoke-local-validation.json`, which validated the scenarios
against a local POS + local Postgres. This one goes through the whole deployed
path: public API Gateway → VPC Link → internal ALB → ECS Fargate → RDS.

## Result — all three thresholds green

| Threshold | Target | Run 1 | Run 2 |
| --- | --- | --- | --- |
| `checks` | `rate>0.99` | **100.00%** (600/600) | **100.00%** (575/575) |
| `http_req_duration` | `p(95)<500ms` | **277.69 ms** | **348.00 ms** |
| `http_req_failed` | `rate<0.01` | **0.00%** (0/364) | **0.00%** (0/349) |

Run 2 is the archived one (`k6-smoke-deployed-summary.json`); both are reported
because p95 moved 278 → 348 ms between otherwise identical runs, which is the
spread a capacity model should account for rather than a single reading.

5 VUs, 1 minute, 115 iterations, ~5.6 req/s. Roughly 30% headroom against the
500 ms budget at this level — a floor, not a ceiling: `baseline.js` is the
scenario that finds the knee, and has not been run against this target yet.

## What this run does and does not prove

**Proves, end to end against real infrastructure:** tenant bootstrap, dev-token
auth, `POST /sales` with server-computed totals, sale reads — all committing to
RDS over TLS, through the real edge.

**Does not prove the full money path.** `payments` is at `desiredCount 0`.
`POST /sales/{id}/pay` returns `202 Accepted` because POS accepts the pay
request asynchronously and answers before Payments is involved, so the check
passes with Payments down. A complete sale → STK → paid run needs `payments`
deployed. Recorded here so the 202 is not read as a completed payment.

## Reproduce

```bash
k6 run --out json=k6/results/smoke-deployed-$(date -u +%Y%m%dT%H%M%SZ).json \
  --summary-export k6/results/smoke-deployed-summary.json \
  k6/smoke.js -e BASE_URL=https://k0lzgyvn1i.execute-api.us-east-1.amazonaws.com
```

`POS_PREFIX` defaults to `/api/pos`, which is what the ALB listener rule matches
(`infra/edge.tf`). Raw per-request JSON stays in `k6/results/` (gitignored, ~1.6 MB);
the summary is committed here.

**Strip `setup_data` before committing a summary.** `--summary-export` dumps
whatever `setup()` returned, and `bootstrapTenant()` returns a live owner JWT —
so the raw file carries a working credential. Gitleaks caught exactly that on
the first attempt at this commit. Only the `metrics` and `root_group` keys are
evidence; `setup_data` is not:

```bash
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); d.pop('setup_data',None); json.dump(d,open(sys.argv[1],'w'),indent=2)" \
  k6/results/smoke-deployed-summary.json
```

## Two bugs this run exists because of

The deployed target could not serve a single DB-backed request until both were
fixed today — the reference image had masked both since G1:

1. **Edge prefix never stripped** (#28). The edge forwards `/pos/...` unchanged
   and the TypeScript services only served bare paths, so every public route
   404'd. Fixed in `@tillflow/shared/routePrefix` via Fastify's `rewriteUrl`.
2. **`sslmode` dropped from the app database URL** (#30 pos, #31 payments).
   `rds.force_ssl=1` refused every app connection. The migration only writes
   that secret when it *creates* the role, so the fix could not reach the live
   environment by re-running it — the secret was patched by hand. That
   repair gap is worth a runbook entry before G4.

Both share a failure shape worth remembering: `/health` and `/ready` touch no
database, so they answered 200 throughout. ECS and the ALB saw a healthy
target while every real route was broken. The external probe is what caught
it, because it asserts `/ready` **and** the response body from outside the VPC.
