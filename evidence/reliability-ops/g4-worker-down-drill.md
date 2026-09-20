# G4 — worker-down / DLQ backlog drill (2.3, 2.8) + game-day (2.10)

**DRI:** Rigbe — Reliability + operations. Executed 2026-09-20 against the real deployed
`pos`/`pos-worker` services and the real `devops-g1-sale-events` queue/alarm/Slack path.
No part of this was simulated — the queue backlog, the alarm evaluation, and both Slack
messages are all real CloudWatch/SQS/Lambda behavior triggered by a real `desiredCount`
change.

Covers `docs/runbook.md` §2.3 ("Platform failure — cache or worker down") and §2.8
("Queue backlog / DLQ depth rising") — the runbook's own text says these are one drill,
not two, once the alarms exist. It also **is** the game-day drill (§2.10): one real firing
alert and one real recovery alert, both checked against the 9-field contract, timed
start to recovery — `docs/ownership.md`'s stated minimum personal proof for Area 4.

## Why this drill, not a manufactured one

`sale.paid` events are published exclusively by `payments`' outbox relay
(`services/payments/src/services/outbox.ts`), and `payments` isn't deployed yet
(`desiredCount 0` at the time of this drill — see `docs/g4-plan.md` §3). Rather than wait
on that, a real sale was created through POS's real, live API (`POST /sales`, genuinely
`UNPAID` in the real database), and the `sale.paid` message `payments` would have
published for it was hand-constructed to the exact `SalePaidEvent` schema
(`services/_shared/ts/src/events.ts`) and sent directly to the real queue via `aws sqs
send-message`. `applySalePaid` (`services/pos/src/services/saleService.ts`) only checks
`saleId`/`tenantId` against a real row — it doesn't validate the charge against Payments —
so this is a faithful exercise of the worker's real consumption path, the real queue, the
real alarm, and the real Slack pipeline. The only synthetic part is *how* the message was
produced, not what happened to it once it existed.

## Timeline (all UTC)

| Time | Event |
| --- | --- |
| 06:38:06 | `devops-g1-pos-worker` scaled to 0 (drill start) |
| 06:38:26 | Real `sale.paid` message sent to `devops-g1-sale-events`, referencing a real `UNPAID` sale |
| 06:45:36 | **FIRING** — `devops-g1-sale-events-age` alarm, organically triggered (not `set-alarm-state`) |
| 06:47:59 | `devops-g1-pos-worker` scaled back to 1 (recovery start) |
| ~06:48:10 | Sale confirmed `PAID`; queue confirmed empty (0 messages) |
| 06:53:53 | **RECOVERED** — alarm back to `OK` |

**Detection: 7m30s** (worker-down → FIRING). **Recovery: 5m54s** (worker-up → RECOVERED).
**Total: 15m47s** (worker-down → alarm clear).

## What was actually run

Bootstrap (create a real sale):

```bash
API=https://$(aws apigatewayv2 get-apis --query "Items[?Name=='devops-g1'].ApiEndpoint | [0]" --output text | sed 's|https://||')

TENANT_JSON=$(curl -s -X POST "$API/api/pos/tenants" -H 'content-type: application/json' \
  -d '{"name":"G4 drill tenant","tillNumber":"174379","ownerExternalAuthId":"g4-drill-owner","ownerDisplayName":"G4 Drill"}')
TENANT_ID=$(echo "$TENANT_JSON" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

TOKEN=$(curl -s -X POST "$API/api/pos/dev/tokens" -H 'content-type: application/json' \
  -d '{"tenantId":"'"$TENANT_ID"'","externalAuthId":"g4-drill-owner"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

ATTENDANT_ID=$(curl -s -X POST "$API/api/pos/tenants/$TENANT_ID/attendants" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"externalAuthId":"g4-drill-attendant","displayName":"G4 Attendant","msisdn":"254708374149"}' \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

PRODUCT_ID=$(curl -s -X POST "$API/api/pos/tenants/$TENANT_ID/products" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"G4 Widget","unitPriceMinor":25000}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

SALE_JSON=$(curl -s -X POST "$API/api/pos/sales" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: g4-drill-$(date +%s)" \
  -d '{"attendantId":"'"$ATTENDANT_ID"'","items":[{"productId":"'"$PRODUCT_ID"'","quantity":1}]}')
SALE_ID=$(echo "$SALE_JSON" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
# TENANT_ID=b5965970-e22c-4576-99f5-2b2c098e5e97, SALE_ID=7707d097-f25d-4e1e-bcce-e2975ca7ad39
```

Kill the worker, inject the event:

```bash
aws ecs update-service --cluster devops-g1 --service devops-g1-pos-worker --desired-count 0
aws ecs wait services-stable --cluster devops-g1 --services devops-g1-pos-worker

QUEUE_URL=$(aws sqs get-queue-url --queue-name devops-g1-sale-events --query QueueUrl --output text)
EVENT_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
CHARGE_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
BODY='{"eventType":"sale.paid","eventId":"'"$EVENT_ID"'","occurredAt":"'"$NOW"'","data":{"saleId":"'"$SALE_ID"'","tenantId":"'"$TENANT_ID"'","chargeId":"'"$CHARGE_ID"'","amountMinor":25000,"paidAt":"'"$NOW"'"}}'

aws sqs send-message --queue-url "$QUEUE_URL" --message-body "$BODY"
```

Poll for the real alarm transition (no `set-alarm-state` anywhere in this drill):

```bash
for i in $(seq 1 20); do
  STATE=$(aws cloudwatch describe-alarms --alarm-names devops-g1-sale-events-age \
    --query 'MetricAlarms[0].StateValue' --output text)
  echo "$(date -u +%H:%M:%S) state=$STATE"
  [ "$STATE" = "ALARM" ] && break
  sleep 30
done
```

Recovery:

```bash
aws ecs update-service --cluster devops-g1 --service devops-g1-pos-worker --desired-count 1
aws ecs wait services-stable --cluster devops-g1 --services devops-g1-pos-worker
# then the same poll loop, watching for OK instead of ALARM
```

Confirmed after recovery: `GET /sales/{id}` → `"status":"PAID"`, `paidAt` set;
`ApproximateNumberOfMessages` on the queue → `0`.

## Both Slack messages, transcribed

**FIRING**, 9:45 AM EAT (06:45:36 UTC), `#group-1-devops`:

```
FIRING  devops-g1-sale-events-age

symptom: The sale-events queue is not draining.
user/SLO impact: sale.paid events are delayed; POS will not mark sales paid.

environment: prod                    service: pos
owner: rigbe                         observed: ApproximateAgeOfOldestMessage >
                                      120s on 3 of the last 5 minutes.
grafana: https://g-abb9c4666f.grafana-workspace.us-east-1.amazonaws.com
runbook: docs/runbook.md#23-platform-failure--cache-or-worker-down
first safe action: Check the consumer service is running and not erroring.
                    Do not purge the queue.
```

**RECOVERED**, 9:53 AM EAT (06:53:53 UTC), `#group-1-devops` — identical contract fields,
header changed to `RECOVERED devops-g1-sale-events-age`.

Both carry all nine fields. Both resolved through the real pipeline: CloudWatch alarm →
SNS `devops-g1-alerts` → Lambda `devops-g1-slack-alerts` → Secrets Manager
`devops-g1/slack-webhook` → Slack, landing in `#group-1-devops` (moved there from the
cohort-wide `#all-codehive-2025` earlier — `docs/runbook.md`).

## What this proves, and what it doesn't

**Proven:** the worker-down/DLQ backlog procedure works end to end for real — a genuine
backlog produces a genuine alarm, the alarm produces a genuine actionable Slack message
matching the contract, fixing the real cause (worker back up) produces genuine recovery
in both the data (sale PAID, queue empty) and the alert (RECOVERED). Both `docs/runbook.md`
§2.3/§2.8's "Proof (G4)" lines and §2.10's game-day deliverable are satisfied by this one
drill, per the runbook's own note that they're the same drill.

**Not proven here:** DLQ redrive specifically (no message reached `maxReceiveCount` in
this run — the worker came back before that), and this doesn't exercise the `sale.paid`
outbox relay itself (that's `payments`' code, Nebyat's drill once `payments` is deployed —
`docs/g4-plan.md` §2).
