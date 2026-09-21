# Grafana SLO dashboard — authored, not yet verified in the workspace

**Status: NOT evidence yet.** [`grafana-slo-dashboard.import.json`](grafana-slo-dashboard.import.json)
was written as JSON and structurally checked locally (unique ids, every metric-math reference
resolves inside its own panel, no layout overlap). It has **not** been imported into workspace
`g-abb9c4666f`, so nothing here proves a panel renders data. It becomes evidence only after the
steps below, when it is re-exported from the workspace.

It closes the gap [`grafana-dashboard-export.md`](grafana-dashboard-export.md) states plainly: the
capacity export has no uptime panel, and no panel reads the `TillFlow` namespace, so there is no
budget-remaining or burn-rate panel — the gate's "uptime/SLO/budget panels" wording.

## Import, verify, re-export

1. Grafana → **Dashboards → New → Import → Upload dashboard JSON file** → this file. When it asks
   for `DS_CLOUDWATCH`, pick the workspace's CloudWatch data source.
2. Check each panel against the table below. A panel showing an error banner names the bad query;
   that is expected to be a small fix, not a redesign (see "What is unverified").
3. **Export → Export as JSON** (leave "Export for sharing externally" off, as the capacity export
   was), save as `grafana-slo-dashboard-export.json`, delete the `.import.json`, and update the
   README index row. A stale export reads as evidence of panels that no longer exist, so replace
   rather than accumulate.
4. In the *capacity* dashboard, rename the panel still titled "New panel" (it is the target-5xx
   panel) and re-export that file too.

## Every panel mirrors something an alarm watches

The design rule from `grafana-dashboard-spec.md`: a panel and its alarm must never disagree, so the
queries are the alarms' own (`infra/observability.tf`), not paraphrases.

| Panel | Reads | Same as |
| --- | --- | --- |
| Uptime — 5m / 1h / 28d / latest | `CloudWatchSynthetics/SuccessPercent`, `CanaryName=devops-g1-uptime` | `canary_failed` |
| POS sale writes by result | `TillFlow/pos_sale_write_total`, `OTelLib=@tillflow/pos`, one series per `result` | the alarms' four inputs |
| POS sale-write error rate | `IF(total > 0, bad / total, 0)` | the burn-rate alarms' `rate` |
| Error budget remaining (stat + trend) | daily `RUNNING_SUM` over 28d, `100 × (1 − consumed)` | `pos_budget_low`, which can only see 7 days |
| Fast burn (1h **and** 5m) | `1000 × error rate` at 3600 s and 300 s | `pos_fast_burn` + `_short` |
| Slow burn (6h **and** 30m) | `1000 × error rate` at 21600 s and 1800 s | `pos_slow_burn` + `_short` |
| POS target latency p95 | `AWS/ApplicationELB/TargetResponseTime` p95, pos target group | `tg_p95`; SLO < 400 ms |
| POS ECS CPU / memory | `AWS/ECS`, `devops-g1-pos` | `ecs_cpu` (70%), `ecs_memory` (75%) |
| sale-events queue age | `AWS/SQS/ApproximateAgeOfOldestMessage` | `queue_age` (120 s) |

The dimension facts are the ones `grafana-dashboard-export.md` records and
`infra/observability.tf` was written around: namespace `TillFlow` is **flat**, services differ by
`OTelLib` (not `service.name`), and `NoDimensionRollup` means no pre-aggregated series, so every
`result` value is queried and summed explicitly.

## What is unverified — read before trusting a green panel

- **Query shape for metric-math targets.** The plugin schema was written from knowledge of the
  CloudWatch data source (`metricQueryType: 0`, `metricEditorMode: 1`, `expression`, hidden
  component queries referenced by `id`), not checked against this workspace's version (AMG 12.4).
  If Grafana rejects one, fix that panel in the UI and re-export; the export is what counts.
- **`noValue` can hide a broken query.** A series exists only once it has been emitted, so the
  error-rate and budget panels are set to read `0` / `100` when there is no data. That is right
  when nothing has failed and *wrong-looking-right* when the query itself is broken. Sanity gate:
  "POS sale writes by result" must show a live `ok` series while traffic flows. If that is empty,
  every panel below it is empty for the wrong reason.
- **The `error` series does not exist until `pos` is redeployed** with `fix/g3-pos-sli-error-result`
  and a real failure occurs. Until then the budget panel reading 100% is the honest answer, but it
  is not proof the SLO can detect a failure. That proof is a drill — inject a failure, watch the
  alarm move — not a panel.
- **28-day panels need 28 days of history.** `TillFlow` metrics exist only from when the counters and
  the exporter first shipped, so the 28d trend and the budget will cover far less than 28 days for
  now — the panel shows what exists, not a full window. CloudWatch keeps 1-minute data for 15 days;
  the 28d and 7d panels use 1-hour and 1-day periods for that reason.
