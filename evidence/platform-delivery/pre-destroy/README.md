# Pre-destroy snapshot — live state that `terraform destroy` will take with it

**Captured:** 2026-09-24, before G5's destroy/rebuild. **DRI:** Meron.

Almost all G3/G4 evidence is already committed as files — drill write-ups, k6 summaries,
Grafana exports, Slack screenshots — and survives a destroy untouched. Three things do
not, because they live in CloudWatch rather than in the repo:

| File | What it holds | Why it cannot be recreated |
| --- | --- | --- |
| [`alarm-inventory.txt`](alarm-inventory.txt) | All 32 alarms (30 metric + 2 composite) and their state at capture time | A rebuild recreates the alarms, but not the fact that *these* were live, named and in this state at the end of G4 |
| [`probe-history-72h.txt`](probe-history-72h.txt) | 72 hours of `CloudWatchSynthetics/SuccessPercent`, hourly avg + min | Metric data is deleted with the metric. A rebuilt probe starts from zero history |
| [`slack-delivery-7d.txt`](slack-delivery-7d.txt) | 28 `ALARM -> 200` / `OK -> 200` deliveries from the renderer Lambda, timestamped | The log group goes with the stack |

## What the probe history actually shows

Hourly buckets, so a short outage shows as a dip rather than a zero. The one dip in 72
hours:

```
2026-09-23T17:47:00Z   avg 88.33   min 0.0
```

That is **G4 drill 2.6** — the deliberate ALB listener-rule break
(`../g4-canary-edge-drill.md`). `min 0.0` is the probe genuinely failing; `avg 88.33` is
that failure averaged across the hour. Every other bucket is a flat `100.0`.

This is worth keeping precisely because it is *not* flat: it is the external probe
catching a real outage, visible in the metric rather than only in a drill write-up.

## What the Slack log shows

28 deliveries, every one a `-> 200`, in ALARM/OK pairs. These are not screenshots — they
are the renderer Lambda recording that Slack **accepted** each notification. A screenshot
shows what was rendered; this shows what was delivered.

The pairs cluster around the drills: forced transitions for the G3 alerting proof, then
the real ones from drill 2.6.

## Reproduce

```bash
export AWS_PROFILE=devops-lab-new

aws cloudwatch describe-alarms --alarm-name-prefix devops-g1 --region us-east-1 \
  --alarm-types MetricAlarm CompositeAlarm \
  --query '{metric:sort_by(MetricAlarms,&AlarmName)[].{n:AlarmName,s:StateValue},composite:sort_by(CompositeAlarms,&AlarmName)[].{n:AlarmName,s:StateValue}}' \
  --output table

aws cloudwatch get-metric-statistics --namespace CloudWatchSynthetics \
  --metric-name SuccessPercent --dimensions Name=CanaryName,Value=devops-g1-uptime \
  --start-time "$(date -u -v-72H +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 3600 --statistics Average Minimum --region us-east-1 \
  --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Average,Minimum]' --output text

aws logs filter-log-events --log-group-name /aws/lambda/devops-g1-slack-alerts \
  --region us-east-1 --filter-pattern '"slack devops-g1"' \
  --start-time "$(python3 -c 'import time;print(int((time.time()-604800)*1000))')"
```

After the rebuild, the same commands answer differently — 32 alarms again, but no probe
history and no delivery log. That difference is the point: it is what "reproducible
infrastructure, non-reproducible operational history" looks like, and it is worth saying
out loud rather than quietly re-capturing and presenting as continuous.
