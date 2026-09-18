# Grafana dashboard build spec (G3)

**DRI:** Rigbe — Reliability + operations. **Status: spec only, not yet built.**

Per `infra/README.md`'s "Grafana access (G3)" and the ownership scope note in
`infra/observability.tf` (still on `origin/feat/g3-observability`, not yet merged to
`main`): the AMG **workspace** and its CloudWatch/X-Ray data sources are Platform's
(Meron); the **dashboards built inside it** are Reliability's (Rigbe) — Terraform
deliberately creates nothing here. Building them means logging into
`https://g-abb9c4666f.grafana-workspace.us-east-1.amazonaws.com` via IAM Identity Center
SSO and using the UI, which needs a human in a browser — not something this session can
do. This doc is the spec so that building it is mechanical once someone is logged in:
one panel per row, exact CloudWatch namespace/metric/dimensions pulled straight from the
matching alarm in `infra/observability.tf`, so every panel and its alarm agree.

## Prerequisites (already done, per Meron)
- Data sources: CloudWatch + X-Ray, both registered on `aws_grafana_workspace.main`.
- Access: `aws grafana update-permissions ... role=ADMIN` already run for Rigbe.

## Dashboard 1 — Uptime / SLO (top-level, per `docs/slo-error-budgets.md`)

Template variable `$service` = `pos | payments | commission | web` (from resource tags —
the IAM grant's `tag:GetResources` is there specifically for this).

| Panel | Namespace / metric | Dimensions | Stat / period | Matches alarm |
| --- | --- | --- | --- | --- |
| External uptime (canary) | `CloudWatchSynthetics` / `SuccessPercent` | canary name | Average / 60s | `canary_failed` |
| Edge 5xx (API Gateway) | `AWS/ApiGateway` / `5xx` | `ApiId` | Sum / 60s | `apigw_5xx` |
| Target 5xx by service | `AWS/ApplicationELB` / `HTTPCode_Target_5XX_Count` | `LoadBalancer`, `TargetGroup=$service` | Sum / 60s | `tg_5xx` |
| Unhealthy hosts by service | `AWS/ApplicationELB` / `UnHealthyHostCount` | `LoadBalancer`, `TargetGroup=$service` | Average / 60s | `tg_unhealthy` |
| p95 latency by service | `AWS/ApplicationELB` / `TargetResponseTime` | `LoadBalancer`, `TargetGroup=$service` | p95 / 60s | `tg_p95` |

Add horizontal threshold lines matching the alarm thresholds (5xx ≥ 5/5min, p95 per
`docs/slo-error-budgets.md`'s per-service targets — 500ms web/POS, payments per its own
row) so a panel and its alarm read the same story.

## Dashboard 2 — Capacity / saturation

Template variable `$service` = `pos | payments | commission | web`.

| Panel | Namespace / metric | Dimensions | Stat / period | Matches alarm |
| --- | --- | --- | --- | --- |
| ECS CPU by service | `AWS/ECS` / `CPUUtilization` | `ClusterName`, `ServiceName=$service` | Average / 60s | `ecs_cpu` (70% line) |
| ECS memory by service | `AWS/ECS` / `MemoryUtilization` | `ClusterName`, `ServiceName=$service` | Average / 60s | `ecs_memory` (75% line) |
| RDS CPU | `AWS/RDS` / `CPUUtilization` | `DBInstanceIdentifier` | Average / 60s | `rds_cpu` (80% line) |
| RDS free storage | `AWS/RDS` / `FreeStorageSpace` | `DBInstanceIdentifier` | Average / 60s | `rds_storage` (2 GiB line) |
| Queue age by queue | `AWS/SQS` / `ApproximateAgeOfOldestMessage` | `QueueName` (`sale-events`, `commission-payout` — per-service, see `docs/slo-error-budgets.md`'s corrected caveat) | Maximum / 60s | `queue_age` (120s line) |
| DLQ depth by queue | `AWS/SQS` / `ApproximateNumberOfMessagesVisible` on the `-dlq` queues | `QueueName` | Maximum / 60s | `dlq_depth` |

This is the dashboard `k6/README.md`'s "Report" section means by "Infra (from Grafana,
correlated): CPU < 70%, memory < 75%, bounded SQS queue age" — read it side by side with
a k6 run.

## Dashboard 3 — Error budget (blocked on more than the workspace)

`docs/slo-error-budgets.md`'s per-SLI numerators (`pos_sale_write_total`,
`payments_command_total`, `commission_payout_total`, etc.) are custom OTLp metrics, not
CloudWatch infra metrics — **not buildable from Dashboards 1–2's data sources alone.**
Two more things have to land first, in order:
1. `services/_shared/ts/src/otel.ts`'s `getMeter()` / `sliCounter()` / `sliHistogram()` —
   already written on `origin/feat/g3-observability` (not yet merged to `main`) — merged.
2. Each service actually calling `sliCounter()`/`sliHistogram()` at its SLI's numerator
   (e.g. POS's `POST /sales` handler recording `ok`/`error` per
   `docs/slo-error-budgets.md`'s POS row) — **not written anywhere yet**, in `main` or on
   that branch. Landing (1) alone does not populate this dashboard; it only makes (2)
   possible.

Budget-burn math (14.4×/1h, 6×/6h per `docs/slo-error-budgets.md`) is a CloudWatch metric
math expression over whichever of those counters exists — write the expression once (1)
and (2) are both real and there is live data to check it against, not before.

## X-Ray panel

Add an "Explore" or panel of type "Traces" against the X-Ray data source, no fixed query
— the runbook's `docs/runbook.md` trace workflow is "pull `trace_id` from an alert,
paste it here," which needs search-by-id, not a saved panel.

## When this is actually built

Export the finished dashboard as JSON (Grafana's dashboard settings → JSON Model, or
`GetDashboard` via the AMG API) and commit it to
`evidence/reliability-ops/grafana-dashboard-export.json`, with a short note on what's
live vs. still a placeholder panel (Dashboard 3, per above). That export — not this spec
— is Area 4's actual G3 proof (`docs/gates.md`).
