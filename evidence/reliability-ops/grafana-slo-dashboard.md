# Grafana SLO dashboard — imported and exported from the workspace

[`grafana-slo-dashboard-export.json`](grafana-slo-dashboard-export.json) is a real export (Export →
Export as JSON, "Export for sharing externally" off) of dashboard `tillflow-slo` in workspace
`g-abb9c4666f`, taken on 2026-09-21 after the panels were imported and looked at. It is the
committed artifact; the hand-authored import file it came from has been removed so the repo does not
hold two versions of the same dashboard. Grafana 12.4.3, CloudWatch data source, 18 panels.

It closes the gap [`grafana-dashboard-export.md`](grafana-dashboard-export.md) states plainly: the
capacity export has no uptime panel, and no panel reads the `TillFlow` namespace, so there is no
budget-remaining or burn-rate panel — the gate's "uptime/SLO/budget panels" wording.

**One known blemish in the export:** the dashboard's `description` field still reads "AUTHORED AS
JSON -- not an export until re-exported…". That was true when it was written and is stale now; the
file is left byte-for-byte as Grafana produced it rather than hand-edited. Fix it in Grafana
(Settings → Description) and re-export when convenient.

## What was seen rendering live data, and what was not

Confirmed by eye in the workspace after import:

- Uptime panels (5m / 1h / 28d / latest) and the canary series render real data. The 28-day figure
  is 98.667%; the 64 failing minutes behind it are attributed in the scar log and the canary drill
  evidence — a routing bug (404, fixed in PR #28), the platform team's deliberate edge drill (503),
  and API Gateway throttling under load (429). Planned drills and load tests are counted in that
  number: `docs/slo-error-budgets.md` has no exclusion policy for them yet.
- "POS sale writes by result" shows a live `ok` series — the sanity gate below, so the panels that
  sum over it are empty only when nothing has failed.
- POS target latency p95, ECS CPU/memory and sale-events queue age render live data. The queue-age
  spike is very likely the 2026-09-20 worker-down drill; the peak time has not been hovered to
  confirm.
- Fast- and slow-burn panels render flat at 0, as expected with no failed writes.

**Not confirmed:** the error-rate panel and the budget stat/trend have not been checked against
the screen as carefully as the above. Treat them as imported, not proven.

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

## What is still unverified — read before trusting a green panel

- **`noValue` can hide a broken query.** A series exists only once it has been emitted, so the
  error-rate and budget panels read `0` / `100` when there is no data. That is right when nothing
  has failed and *wrong-looking-right* when the query itself is broken. The `ok` series showing live
  data is what makes flat zeros credible; it does not prove the `error` path.
- **The `error` series does not exist until `pos` is redeployed** with `fix/g3-pos-sli-error-result`
  and a real failure occurs. Until then the budget panel reading 100% is the honest answer, but it
  is not proof the SLO can detect a failure. That proof is a drill — inject a failure, watch the
  alarm move — not a panel.
- **28-day panels need 28 days of history.** `TillFlow` metrics exist only from when the counters and
  the exporter first shipped, so the 28d trend and the budget cover far less than 28 days for now —
  the panel shows what exists, not a full window. CloudWatch keeps 1-minute data for 15 days; the
  28d and 7d panels use 1-hour and 1-day periods for that reason.
- **The capacity dashboard still has a panel titled "New panel"** (target 5xx). Rename it in the
  workspace and re-export `grafana-dashboard-export.json`; that file is not touched here.
