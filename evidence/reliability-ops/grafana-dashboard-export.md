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

## Scope — this is the capacity dashboard, not the SLO one

This export covers **capacity**: RPS and target-5xx volume from `AWS/ApplicationELB`. It
was committed while the SLO panels the G3 review asked for did not yet exist.

**They now do.** `devops-g1-slo-dashboard` (#41,
[`grafana-slo-dashboard.md`](grafana-slo-dashboard.md)) adds the 18 panels that close the
review's P0 #1: uptime at 5m/1h/28d from `CloudWatchSynthetics/SuccessPercent`, error
budget remaining over 28 days, fast/slow burn panels matching the alarm thresholds, and
latency/CPU/queue-age saturation — all reading the `TillFlow` namespace.

So the two dashboards are complementary, not overlapping: this one answers *"how much
load did we take and did the ALB return errors"*, the SLO one answers *"how much budget is
left and how fast are we spending it"*.

Still cosmetic in **this** export: one panel is titled "New panel" rather than
"Target 5xx". Worth fixing on the next re-export; it does not affect the query.

### Dimension notes for anyone editing either dashboard

Verified against live CloudWatch, and not obvious — they cost real time to rediscover:

- The namespace is **`TillFlow`, flat** — not `TillFlow/<service>`.
- Services are distinguished by the **`OTelLib`** dimension (`@tillflow/pos`), **not**
  `service.name`.
- `dimension_rollup_option = "NoDimensionRollup"` means there is no pre-aggregated
  series, so a rate panel must sum each `result` value explicitly.

Same constraints the burn-rate alarms were written around; see the comment block at the
bottom of `infra/observability.tf`.

## Reproduce

Workspace → dashboard `devops-g1-capacity-dashboard` → Export → "Export as JSON".
Re-export and replace this file whenever panels change; a stale export is worse than none,
because it reads as evidence of panels that no longer exist.
