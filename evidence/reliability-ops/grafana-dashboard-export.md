# Grafana dashboard export

Closes the export half of the G3 review's **P0 #1**: *"the workspace + CloudWatch/X-Ray
data sources exist; the panels are only a spec. Build them and commit the export."*

Built by Rigbe (Area 4 — dashboards are her deliverable); committed here by Meron so the
artifact exists in the repo rather than only in the workspace.

- **File:** [`grafana-dashboard-export.json`](grafana-dashboard-export.json)
- **Workspace:** `g-abb9c4666f` (AMG 12.4, `infra/observability.tf`)
- **Dashboard uid:** `risv6fw` · schema v42 · exported at version 3

## What it contains

| Panel | Query | Reads |
| --- | --- | --- |
| Requests Per Second (RPS) | `AWS/ApplicationELB` `RequestCount` Sum, 1m | ALB request volume — the k6 runs are visible as spikes to ~3,000/min |
| *(untitled — "New panel")* | `AWS/ApplicationELB` `HTTPCode_Target_5XX_Count` Sum, 1m | Target 5xx |

Both bind to the real load balancer (`app/devops-g1-alb/2bb31700ab6c9137`) through the
Terraform-provisioned CloudWatch data source, so the queries resolve against live data
rather than being a scaffold.

## What it does not yet contain

Stated plainly so this is not read as closing more than it does. The review asked for
*"5m/1h/28d uptime, SLO target, budget remaining, burn rate, RED, saturation, business
signals"* (`grafana-dashboard-spec.md`). This export delivers the **capacity** panels —
RPS and error volume. Still outstanding:

- **No panel reads the `TillFlow` namespace.** The SLI counters
  (`pos_sale_write_total`, and the payments/commission instruments) are emitting, and the
  burn-rate alarms are live in AWS, but no *panel* shows budget remaining or burn rate.
  That is the "budget panels" wording in the gate.
- **No uptime panel** over 5m/1h/28d from `CloudWatchSynthetics/SuccessPercent`, which the
  external probe has been publishing continuously.
- One panel is still titled "New panel".

Dimensions an SLO panel would need, verified against live CloudWatch (these are not
obvious and cost time to rediscover): the namespace is **`TillFlow`, flat** — not
`TillFlow/<service>` — and services are distinguished by the **`OTelLib`** dimension
(`@tillflow/pos`), *not* `service.name`. `dimension_rollup_option = "NoDimensionRollup"`
means there is no pre-aggregated series, so a rate panel has to sum each `result` value
explicitly. Same constraints the burn-rate alarms were written around; see the comment
block at the bottom of `infra/observability.tf`.

## Reproduce

Workspace → dashboard `devops-g1-capacity-dashboard` → Export → "Export as JSON".
Re-export and replace this file whenever panels change; a stale export is worse than none,
because it reads as evidence of panels that no longer exist.
