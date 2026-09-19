# Slack alerting — firing and recovery

G3: *"Slack firing/recovery"*, and the **"no actionable alert"** blocker.

Added by Meron (Platform) into Reliability's evidence directory, because the alert
*contract* being evidenced here is Area 4's (`docs/runbook.md`) — the plumbing is
Area 3's. See `docs/ownership.md`.

## What is proven

| Claim | Proof |
| --- | --- |
| A CloudWatch alarm reaches a human Slack channel | [`slack-alert-firing.png`](slack-alert-firing.png) — red **FIRING**, `#all-codehive-2025`, 11:33 |
| Recovery is signalled too, not just failure | [`slack-alert-recovered.png`](slack-alert-recovered.png) — green **RECOVERED**, 11:34 |
| Slack actually accepted both, not just that we sent them | [`slack-alert-delivery.txt`](slack-alert-delivery.txt) — `ALARM -> 200` and `OK -> 200` from the renderer Lambda |
| The alert is *actionable*, not just a notification | Both messages carry all nine fields of the `docs/runbook.md` contract: environment, service, symptom, user/SLO impact, observed value, Grafana panel link, runbook link, owner, first safe action |

The log is the load-bearing artifact. A screenshot shows what we rendered; the `-> 200`
lines show what Slack accepted.

## Delivery path

```
CloudWatch alarm
  -> SNS topic devops-g1-alerts        (KMS-encrypted, own CMK)
  -> Lambda devops-g1-slack-alerts     (infra/alerting/slack.py)
  -> Secrets Manager devops-g1/slack-webhook
  -> Slack incoming webhook -> #all-codehive-2025
```

Every alarm publishes on **both** `alarm_actions` and `ok_actions`, so firing and
recovery are one mechanism rather than two.

The renderer invents no wording. Each alarm's `alarm_description` in
`infra/observability.tf` carries the nine-field contract as JSON and the Lambda only
formats it — which is why the alert text stays Reliability's to own and Platform's to
deliver.

## Reproduce

```bash
# FIRING
aws cloudwatch set-alarm-state \
  --alarm-name devops-g1-uptime-probe-failing \
  --state-value ALARM --state-reason "evidence: firing" \
  --profile devops-lab-new --region us-east-1

# RECOVERY
aws cloudwatch set-alarm-state \
  --alarm-name devops-g1-uptime-probe-failing \
  --state-value OK --state-reason "evidence: recovery" \
  --profile devops-lab-new --region us-east-1

# Confirm Slack accepted both
aws logs tail /aws/lambda/devops-g1-slack-alerts --since 5m \
  --profile devops-lab-new --region us-east-1
```

`set-alarm-state` sets the state manually; the alarm **self-corrects from real probe
data within ~5 minutes**, so this leaves nothing in a false state. It is the documented
way to exercise an alarm's actions without breaking production to do it.

Expect two `-> 200` lines. Other outcomes:

| Log line | Meaning |
| --- | --- |
| `slack ... -> 200` | delivered |
| `slack webhook is placeholder; dropping notification` | `devops-g1/slack-webhook` still holds the Terraform placeholder |
| `slack http 404` | webhook URL is wrong, or the Slack app was uninstalled |

## Notes

- The webhook secret is written **out of band**, never by Terraform — `infra/secrets.tf`
  creates the secret with a placeholder value only. A webhook URL is a credential: anyone
  holding it can post to the channel.
- Alerts land in the `codeHive2025` workspace rather than a TillFlow-specific one: app
  creation is disabled in the school workspace. Channel name, secret and alert contract
  are unchanged by that.
- **Channel moved since this was captured.** These screenshots/log show
  `#all-codehive-2025` — that's the workspace's auto-created "all-" default channel
  (101 members, the whole cohort), which a member outside this team noticed and flagged.
  The webhook now points at a private `#group-1-devops` channel instead; same Slack app,
  same `devops-g1/slack-webhook` secret path, same nine-field contract — only the
  destination channel changed (`docs/runbook.md`). This drill's proof of the *mechanism*
  stands regardless; only the channel named in these artifacts is dated.
- `owner` in these two screenshots reads `meron` because the uptime probe is an edge
  alarm. The per-service alarms carry `rigbe` / `nebyat` from `local.service_owner`, so
  an alert routes to the DRI of the area that owns the failing service.
