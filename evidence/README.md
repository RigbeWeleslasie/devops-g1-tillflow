# evidence/

Per-area runtime proof + **exact reproduction commands**. Screenshots alone earn no
credit — every claim needs a command a reviewer can run and a linked artifact
(k6 JSON, trace export, Grafana JSON, scan report, terraform plan, restore log).

```
evidence/
├─ product-pos/         DRI: Rigbe   — e2e sale demo, idempotency tests
├─ payments-integrity/  DRI: Nebyat  — invariant tests, replay drills, traces
├─ platform-delivery/   DRI: Meron   — terraform plan, naming/tag audit, pipeline release
├─ reliability-ops/     DRI: Rigbe   — Grafana export, k6 JSON + analysis, game day
└─ shared/              group        — k6 results, traces, alerts, scans, restore test
```

Each area folder has a `README.md` that lists: what is proven, the command(s) to
reproduce, and links to the committed artifacts / PRs.
