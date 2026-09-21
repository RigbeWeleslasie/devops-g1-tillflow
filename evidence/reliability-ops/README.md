# evidence/reliability-ops

**DRI:** Rigbe — Reliability + operations

## Index

| Claim | Proof | Reproduce |
| --- | --- | --- |
| `k6/smoke.js`, `k6/baseline.js`, `k6/spike.js`, `k6/soak.js` are real, working load tests — not just written | All four run end to end against a real POS server + real Postgres 16 (not `pg-mem`, not a mock): `smoke.js` 210 iterations / 1050 checks, `baseline.js` 91 iterations / 364 checks, `spike.js` 851 iterations / 1702 checks (correctly ramping to 10× baseline VUs), `soak.js` 239 iterations / 717 checks — **100% checks passed, 0% `http_req_failed`, all three thresholds green on every run** | see below |
| `/dev/tokens` was silently unreachable in any real deployed image, then found to default *open* in a way that chained with the unauthenticated tenant-bootstrap route into a credential-free owner JWT | Both found while writing/reviewing `k6/lib/pos.js`'s `bootstrapTenant()`; fixed in `services/pos/src/plugins/auth.ts` (now opt-in, `DEV_AUTH_ENABLED=true` required) + `infra/service-mesh.tf` (explicit grant) — full writeup `docs/scar-log.md` | `services/pos/test/devTokens.test.ts` — 404 with no option/env var, 404 with `devAuthEnabled: false`, 200-with-working-token only when explicitly opted in |
| Runbook procedures exist for every G3 alarm class before the alarms themselves do | `docs/runbook.md` §2.6–2.10 + the "Alarm → runbook section" index, so `infra/observability.tf`'s `alarm_description.runbook` field has somewhere real to point on day one — confirmed against the actual alarm resources on `origin/feat/g3-observability` | read `docs/runbook.md` |
| Grafana dashboard build spec — one panel per CloudWatch alarm in `infra/observability.tf`, dimensions matched exactly, so a panel and its alarm never disagree | Not yet built — needs a human logged into the AMG workspace via Identity Center SSO (browser), which this session can't do. Spec makes building it mechanical once someone is | [`grafana-dashboard-spec.md`](grafana-dashboard-spec.md) |
| Grafana panels exist as a committed export, not just a spec | `devops-g1-capacity-dashboard` (uid `risv6fw`) exported from workspace g-abb9c4666f: RPS and target-5xx panels bound to the real ALB through the Terraform-provisioned CloudWatch data source. **Capacity panels only** -- no panel reads the `TillFlow` namespace yet, so budget/burn-rate panels are still outstanding | [`grafana-dashboard-export.md`](grafana-dashboard-export.md) |
| Uptime, SLI, error-budget and burn-rate panels | Real export of the imported dashboard (18 panels, Grafana 12.4.3). Uptime, sale-writes `ok`, latency, ECS and queue-age panels seen rendering live data; error-rate/budget panels imported but not closely confirmed, and the `error` series does not exist until `pos` is redeployed. Stale `description` text and other caveats in the doc | [`grafana-slo-dashboard.md`](grafana-slo-dashboard.md) · [`export`](grafana-slo-dashboard-export.json) |
| The full sale->pay flow runs green with ALL FOUR services live, and the "a timeout is not a decline" invariant holds under load | 2026-09-21: checks 100%, p95 285.91ms against a 500ms budget, 0% failed -- and the run exposed that 115 real charges were created, every STK push timed out against unset Daraja credentials, and every one was held PENDING and picked up by the reconciler rather than marked FAILED (added by Meron) | [`k6-fullflow-run.md`](k6-fullflow-run.md) |
| k6 runs green against the DEPLOYED target, not just locally | All three thresholds pass through the real edge (API GW -> VPC Link -> ALB -> ECS -> RDS): checks 100%, p95 278 ms / 348 ms across two runs against a 500 ms budget, 0% failed. Full money path NOT covered -- `payments` is at desiredCount 0 and POS answers the pay call 202 asynchronously (added by Meron) | [`k6-deployed-run.md`](k6-deployed-run.md) |
| A CloudWatch alarm reaches Slack as an *actionable* alert, and recovery is signalled too | Forced ALARM -> OK on `devops-g1-uptime-probe-failing`: both rendered into `#all-codehive-2025` with all nine `docs/runbook.md` contract fields, and the renderer Lambda logged `-> 200` for each. Screenshots + raw log beside this file (added by Meron -- the plumbing is Area 3, the alert contract is Area 4) | [`slack-alerting.md`](slack-alerting.md) |

## Reproduce the k6 validation runs

Requires a local Postgres (none deployed here — this is local validation, not a run
against the real AWS target, which needs `infra/observability.tf` + a real deploy first):

```bash
brew install postgresql@16 k6
pg_ctl -D /opt/homebrew/var/postgresql@16 start
createdb tillflow_k6

cd services/pos
npm run build
ADMIN_DATABASE_URL="postgres://$(whoami)@localhost:5432/tillflow_k6" node --import tsx src/migrate.ts
# prints a generated app password -- use it below

PORT=18095 \
DATABASE_URL="postgres://devops-g1-pos-app:<generated password>@localhost:5432/tillflow_k6" \
JWT_SECRET=local-secret PAYMENTS_BASE_URL=http://localhost:1 SERVICE_TOKEN=local-token-16chars \
SERVICE_NAME=pos COMMIT_SHA=local DEV_AUTH_ENABLED=true \
node dist/server.js &

cd ../..
k6 run k6/smoke.js -e BASE_URL=http://localhost:18095 -e POS_PREFIX=
```

`POS_PREFIX=` (empty) is needed only because there's no API Gateway/ALB edge in front of a
bare local server — against a real deployed target, the default `/api/pos` prefix
(`k6/lib/config.js`) is correct as-is.

Captured output from exactly this: [`k6-smoke-local-validation-summary.txt`](k6-smoke-local-validation-summary.txt),
[`k6-smoke-local-validation.json`](k6-smoke-local-validation.json) (`--summary-export`).

## What this does NOT prove yet

- **No run against the real deployed AWS target** — `infra/observability.tf` (the canary,
  alarms, Managed Grafana) doesn't exist yet (Meron's G3 work), and nothing is deployed to
  ECS. Once both land, `k6/README.md`'s documented `BASE_URL=https://<api-gw-url>` command
  is the real run — this local validation only proves the *scripts* are correct.
- **No knee identified** — `baseline.js` was run with a deliberately short/small override
  (`STEP_VUS=3 STEP_DURATION=5s STEPS=2`) purely to prove the script executes correctly.
  Finding the actual highest sustained RPS where SLOs hold needs a real run against a real
  deployed target, per `k6/README.md`'s "Report" section.
- **`soak.js`'s `SOAK_VUS` default (15) is a placeholder**, not derived from any real
  baseline knee — there isn't one yet. Override it once `baseline.js` has run for real.
- **No Grafana panels, no Synthetics canary, no Slack alert** — the rest of the G3 gate.
  Tracked in `docs/gates.md`.
