# Runbook — TillFlow / devops-g1

- **DRI:** Rigbe (Reliability + operations)
- **Status:** Skeleton for G0. Each procedure is filled in and **rehearsed + timed** for G4.

## 0. On-call basics

| Item | Value |
| ---- | ----- |
| Alert channel | Slack `#devops-g1-alerts` (webhook in Secrets Manager `devops-g1/slack-webhook`) |
| Dashboards | Grafana → `TillFlow / Overview`, `TillFlow / <service>` |
| Traces | Grafana → X-Ray data source, filter by `trace_id` from the alert |
| Escalation | Area DRI (see `ownership.md`) → whole group |

### Slack alert contract (every alert must contain)

`environment` · `service` · `symptom` · `user/SLO impact` · `observed value` ·
`Grafana panel link` · `runbook link` · `owner` · `first safe action`.

## 1. RTO / RPO targets

| Scope | RPO | RTO | Basis |
| ----- | --- | --- | ----- |
| AZ failure | ~0 | < 5 min | RDS Multi-AZ sync standby; ECS reschedules across AZs |
| RDS instance loss / corruption | ≤ 5 min | ≤ 30 min | Automated backups + 5-min log; restore to new instance |
| Full stack loss | ≤ 5 min (DB) | ≤ 2 h | `make bootstrap && make deploy` + DB restore + provider reconcile |
| Bad release | 0 | < 10 min | ECS rollback to last-good task def / digest |

## 2. Procedures (skeleton — expand + time for G4)

### 2.1 Uncertain payment (Daraja timeout)

**Symptom:** `payments` charges stuck `PENDING`; STK ack timeout rate up; reconciliation
backlog gauge rising.
**First safe action:** do **not** mass-fail pending charges. Confirm the reconciler is
running (`commission`/`payments` scheduled task healthy).
**Steps:**
1. Grafana → Payments → "Pending age" panel; get affected `checkout_request_id`s.
2. Verify reconciler job ran: logs for `reconcile.run` spans in the last 5 min.
3. For a sample charge, call the admin `stkQuery` endpoint; confirm state resolves.
4. If Daraja sandbox is down: leave charges PENDING, post status, wait. No manual state edits.
5. Recovery signal: pending-age p95 back < threshold, backlog drains to 0.
**Proof (G4):** force scenario `...03`, show retry creates no second charge, show trace.

### 2.2 Callback replay / reorder

**Symptom:** duplicate `callback_events` unique-violation counter spikes (expected, benign)
OR ledger effect count > callback count (BAD — investigate immediately).
**First safe action:** freeze `payments` + `commission` releases if any double effect is
confirmed.
**Steps:**
1. Pull the `trace_id` from the alert; in Grafana view the callback spans — expect
   "second span, zero writes".
2. Query `SELECT count(*) FROM payments_ledger_effects WHERE charge_id = ...` — must be 1.
3. If > 1: P1. Snapshot DB, open scar-log entry, page Payments DRI.
**Proof (G4):** replay + reorder callbacks, show one legal transition, one ledger effect,
one explanatory trace.

### 2.3 Platform failure — cache or worker down

**Symptom:** Redis unreachable / worker DLQ depth > 0 / SQS oldest-message-age rising.
**First safe action:** confirm cache-aside is degrading gracefully (DB fallback), not
erroring. Scale the worker service if CPU-bound.
**Steps:**
1. Grafana → Saturation row; identify the failing component.
2. Cache down → app should serve from RDS (slower). Verify error rate, not just latency.
3. Worker/DLQ → inspect DLQ messages, fix cause, redrive from DLQ to main queue.
4. Recovery signal: DLQ depth 0, oldest-message-age < threshold, error budget burn stops.
**Proof (G4):** kill cache/worker, show degradation + DLQ + actionable Slack alert +
recovery + SLO impact.

### 2.4 Broken release — rollback

**Symptom:** post-deploy smoke fails; 5xx spike right after a deploy; `/version` shows the
new SHA.
**First safe action:** ECS rollback to previous task definition revision (immutable digest).
**Steps:**
1. CodePipeline auto-rollback should trigger on smoke failure — confirm in the console/logs.
2. If manual: `aws ecs update-service --service devops-g1-<svc> --task-definition <prev-revision>`.
3. Verify `/version` reverts, smoke passes, 5xx returns to baseline.
4. Freeze that service; root-cause; forward-fix via new PR.
**Proof (G4):** deploy a controlled failure, detect via smoke, demonstrate rollback.

### 2.5 Restore from backup

**Symptom:** RDS data loss / corruption confirmed.
**Steps (reconciliation order matters):**
1. Create restore target: `aws rds restore-db-instance-to-point-in-time` (or from snapshot)
   → `devops-g1-restore-<ts>`.
2. Point a **safe target** stack at the restored DB (not prod yet).
3. Verify data: latest sale, latest charge, payout ledger row counts vs expectation → RPO check.
4. **Reconcile provider references before declaring recovery:**
   - For every `PENDING`/ambiguous charge in the restored data, run `stkQuery` against
     Daraja to get the authoritative state. Daraja is the source of truth for money moved.
   - For every payout with a `ConversationID` but no terminal state, query B2C result.
   - Only after provider truth is reconciled do we cut traffic over.
5. Record RTO (start → traffic restored). Target ≤ 30 min for the drill.
**Proof (G4):** restore into a safe target, verify RPO/RTO, reconcile, then declare.

## 3. Destroy / rebuild (G5)

```
make destroy          # terraform destroy all roots (services stack, then bootstrap)
# verify: no devops-g1-* resources remain (script in infra/scripts/audit.sh)
make bootstrap        # recreate tfstate bucket + lock
make deploy           # full apply + pipeline
make smoke            # end-to-end
```
Expected wall-clock: to be measured in G5.
