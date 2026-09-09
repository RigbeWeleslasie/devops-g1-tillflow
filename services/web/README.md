# web — frontend / API shell

**DRI:** Rigbe (Product + POS) · **ECS service:** `devops-g1-web` · **ECR:** `devops-g1/web`

Serves the attendant + owner UI and acts as the API shell / BFF, proxying to `pos` and
`payments`. No database of its own.

## Contract
- `GET /health` — liveness (process up)
- `GET /ready` — readiness (downstream APIs reachable)
- `GET /version` — `{ "sha": "...", "digest": "..." }`
- JSON structured logs with `trace_id` / `span_id`
- OTLP export to `localhost:4317` (ADOT sidecar)

## SLI
Eligible page / API-shell loads succeed ≥ 99.9%; p95 < 500 ms. See `docs/slo-error-budgets.md`.

## Local dev
_TBD in G1 — language/framework decision + Dockerfile from `services/_shared` base._

## Evidence
`evidence/product-pos/`
