# G4 — external probe / edge failure drill (2.6)

**DRI:** Meron — Platform + delivery. Covers `docs/runbook.md` §2.6 ("External probe
(canary) failing"), whose stated G4 proof is: *"break the edge deliberately (e.g. a bad
listener rule), show the canary alarm fire, fix it, show recovery in the same Grafana
uptime panel."*

**Status:** EXECUTED 2026-09-20 against the real deployed stack. Detection **2m 07s**,
recovery **4m 27s**, zero Terraform drift. Both Slack messages were real alarm
evaluations, not `set-alarm-state`.
Per `docs/g4-plan.md` §6, a drill only counts once it has a real execution timestamp.

## Why an ALB listener rule

The runbook names a bad listener rule specifically, and it is the right lever for three
reasons:

- It breaks the **edge**, not a service. Every ECS task stays healthy and answers
  `/ready` 200 to its own health check throughout, so this drill proves the thing the
  probe exists for: an in-VPC check cannot see an edge failure.
- It is a **one-command revert** to a known-good value, with no image build, no deploy
  and no data change.
- It is the **exact shape of a real outage we already had**. On 2026-09-19 a deploy
  broke path routing for real, the probe caught it, and Slack alerted — see §"Prior
  unforced occurrence" below. This drill reproduces that deliberately and times it.

Deliberately NOT used:
- Scaling `pos` to 0 — that is drill 2.3 (worker/service down), already covered by Rigbe,
  and it fails the ALB target health check too, so it would not isolate the edge.
- Deleting the API Gateway route — slower to restore and risks a Terraform diff.

## Pre-drill state — capture before touching anything

```bash
export AWS_PROFILE=devops-lab-new
date -u +%Y-%m-%dT%H:%M:%SZ

aws cloudwatch describe-alarms --alarm-names devops-g1-uptime-probe-failing \
  --region us-east-1 --query 'MetricAlarms[0].StateValue' --output text

aws cloudwatch get-metric-statistics --namespace CloudWatchSynthetics \
  --metric-name SuccessPercent --dimensions Name=CanaryName,Value=devops-g1-uptime \
  --start-time "$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 60 --statistics Average --region us-east-1 \
  --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Average]' --output text
```

Expect `OK` and a run of `100.0`. Do not start if the alarm is already in ALARM —
you would be timing someone else's outage.

## The rule being modified

Priority 10 on the ALB's only listener, matching `/api/pos/*` and `/pos/*`:

```
arn:aws:elasticloadbalancing:us-east-1:240462142849:listener-rule/app/devops-g1-alb/2bb31700ab6c9137/b4322221c90a6d49/0f06c13fd35d28da
```

Re-confirm it before running — a `terraform apply` that recreates the listener changes
this ARN:

```bash
LISTENER=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$(aws elbv2 describe-load-balancers --names devops-g1-alb \
      --region us-east-1 --query 'LoadBalancers[0].LoadBalancerArn' --output text)" \
  --region us-east-1 --query 'Listeners[0].ListenerArn' --output text)

aws elbv2 describe-rules --listener-arn "$LISTENER" --region us-east-1 \
  --query 'Rules[?Priority==`10`].{Arn:RuleArn,Cond:Conditions[0].Values}' --output json
```

## T0 — break the edge

```bash
RULE=<arn from above>
echo "T0 BREAK: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

aws elbv2 modify-rule --rule-arn "$RULE" \
  --conditions '[{"Field":"path-pattern","Values":["/g4-drill-broken-path/*"]}]' \
  --region us-east-1 --query 'Rules[0].Conditions[0].Values' --output text
```

`/pos/*` now matches no rule, falls through to the `/*` catch-all, and lands on `web` —
which is at `desiredCount 0`. The probe's `/pos/ready` should start failing within one
minute. **Note the exact UTC time.**

Confirm the break is real, from outside:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://k0lzgyvn1i.execute-api.us-east-1.amazonaws.com/api/pos/ready
```

## T1 — observe detection

Poll until the alarm flips. The alarm is 3-of-5 one-minute datapoints, so expect roughly
3–5 minutes — this is the *deliberate* insensitivity that stops a single blip paging
anyone, and it is worth stating in the write-up rather than presenting as a delay.

```bash
while true; do
  printf '%s ' "$(date -u +%H:%M:%SZ)"
  aws cloudwatch describe-alarms --alarm-names devops-g1-uptime-probe-failing \
    --region us-east-1 --query 'MetricAlarms[0].StateValue' --output text
  sleep 30
done
```

When it reads `ALARM`: **record the time**, and screenshot the Slack message in
`#group-1-devops`. Confirm it is a real evaluation, not a forced one:

```bash
aws cloudwatch describe-alarms --alarm-names devops-g1-uptime-probe-failing \
  --region us-east-1 --query 'MetricAlarms[0].StateReason' --output text
```

A real evaluation says *"Threshold Crossed: N out of the last M datapoints..."*. A forced
one echoes the `--state-reason` string — that would not satisfy the gate.

Also capture delivery, which is the artifact a screenshot cannot fake:

```bash
aws logs tail /aws/lambda/devops-g1-slack-alerts --since 10m \
  --profile devops-lab-new --region us-east-1 | grep 'slack devops-g1'
```

## T2 — recover

```bash
echo "T2 FIX: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

aws elbv2 modify-rule --rule-arn "$RULE" \
  --conditions '[{"Field":"path-pattern","Values":["/api/pos/*","/pos/*"]}]' \
  --region us-east-1 --query 'Rules[0].Conditions[0].Values' --output text

curl -s -o /dev/null -w '%{http_code}\n' \
  https://k0lzgyvn1i.execute-api.us-east-1.amazonaws.com/api/pos/ready
```

Expect 200 immediately. Then keep polling the alarm to `OK`, screenshot the green
RECOVERED message, and record the time.

## T3 — confirm no drift

The rule was changed outside Terraform, so prove it was put back exactly:

```bash
cd infra && AWS_PROFILE=devops-lab-new terraform plan -no-color | grep -E '^Plan:|^No changes'
```

**"No changes" is part of the evidence.** A drill that leaves drift behind has not
finished.

## Timeline — executed 2026-09-20 (all UTC)

| Marker | Time | Evidence |
| --- | --- | --- |
| Baseline captured | 17:03:06 | alarm `OK`; `SuccessPercent` 100.0 × 5 consecutive minutes; `/api/pos/ready` 200 |
| **T0 — rule broken** | **17:05:04** | `modify-rule` returned `/g4-drill-broken-path/*` |
| Break confirmed from outside | 17:06:48 | `/api/pos/ready` and `/pos/ready` both **503** |
| First failing datapoint | 17:05:00 | `SuccessPercent` 0.0 |
| **T1 — alarm ALARM** | **17:07:11** | real threshold crossing (below) |
| Slack FIRING delivered | ~17:07 | `slack devops-g1-uptime-probe-failing ALARM -> 200` |
| **T2 — rule restored** | **17:19:23** | `modify-rule` returned `/api/pos/* /pos/*` |
| Edge serving again | 17:19:45 | both paths **200**, 22s after the fix |
| **Alarm OK** | **17:23:50** | real threshold crossing (below) |
| Slack RECOVERED delivered | ~17:23 | `slack devops-g1-uptime-probe-failing OK -> 200` |
| Terraform drift from the drill | 17:26 | **none** — see below |

**Detection time: 2m 07s** (T0 17:05:04 → T1 17:07:11)
**Recovery time: 4m 27s** (T2 17:19:23 → alarm OK 17:23:50)
**Total outage: 14m 19s** (T0 → T2) — the fix was held deliberately to capture evidence,
not because recovery was slow; the edge was serving again 22 seconds after the revert.

### Both transitions were real evaluations

Not `aws cloudwatch set-alarm-state`. CloudWatch's own reasons:

```
ALARM: Threshold Crossed: 3 out of the last 5 datapoints
       [0.0 (17:07:00), 0.0 (17:06:00), 0.0 (17:05:00)]
       were less than the threshold (100.0)

OK:    Threshold Crossed: 3 out of the last 5 datapoints
       [100.0 (17:22:00), 100.0 (17:21:00), 100.0 (17:20:00)]
       were not less than the threshold (100.0)
```

### The metric series

```
17:01–17:04   100.0  100.0  100.0  100.0      <- healthy
17:05–17:19     0.0 ... 0.0  (15 minutes)     <- broken
17:20–17:25   100.0  100.0  100.0  100.0      <- recovered
```

### The finding that matters

**During the entire 14-minute outage, every in-VPC signal said the service was fine:**

| Signal | During outage |
| --- | --- |
| ECS `desiredCount` / `runningCount` | **2 / 2** |
| ALB target group health | **`healthy healthy`** |
| External probe | **0.0** |

The tasks were genuinely healthy — they answer `/ready` unprefixed on their own port, and
the ALB health check never traverses the listener rule that was broken. So container
health, task health and target health were all green while no user could reach the
service.

This is the "no external probe" blocker demonstrating its own reason for existing: the
only signal that caught this was the one running outside the VPC and asserting the
user's actual path.

### No drift left behind

`terraform plan` after the drill shows only the three pre-existing POS task-definition
replacements (the busybox-placeholder vs real-digest flip tracked separately). The ALB
listener rule does **not** appear in the plan — the revert restored it to exactly the
value Terraform expects.

## Prior unforced occurrence — 2026-09-19

This same failure happened for real the day before, which is worth recording because an
unforced detection is stronger evidence than a staged one.

A deploy (task definition revision 33) shipped an image that expected the edge to strip
the `/pos` prefix, while the edge forwards it unchanged. Every public POS path 404'd.
`SuccessPercent` went from `100.0` at 09:02 to `0.0` at 09:03 UTC, the alarm fired, and
Slack was notified — with no human noticing first.

Throughout, **ECS reported 2/2 tasks healthy and the ALB target group was green**,
because `/health` and `/ready` are served unprefixed and answer 200 to an in-VPC check.
The external probe was the only signal that the service was unreachable to users. That is
precisely the "no external probe" blocker's reason for existing.

Root cause and fix: PR #28 (`@tillflow/shared/routePrefix`), scar-log entry.

## If something goes wrong

The rule is the only thing changed, and it has exactly one correct value:

```bash
aws elbv2 modify-rule --rule-arn "$RULE" \
  --conditions '[{"Field":"path-pattern","Values":["/api/pos/*","/pos/*"]}]' \
  --region us-east-1
```

Nothing else is touched: no images, no task definitions, no data, no Terraform state.
`payments`' priority-20 rule and the `/*` catch-all are untouched, so no other service's
routing changes.
