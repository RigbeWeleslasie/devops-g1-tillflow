# Runbook — TillFlow / devops-g1

- **DRI:** Rigbe (Reliability + operations)
- **Status:** All alarm-triggerable procedures written for G3 (2.1–2.10) and indexed so
  every alarm's `runbook link` resolves to a real section. **2.3/2.8/2.10 rehearsed and
  timed for real** (2026-09-20, `evidence/reliability-ops/g4-worker-down-drill.md`) —
  real backlog, real alarm, real Slack firing/recovery, 7m30s detect / 5m54s recover. The
  rest (2.1/2.2/2.4/2.5/2.6/2.9) are G4 work still open — see `docs/g4-plan.md`.

## 0. On-call basics

| Item | Value |
| ---- | ----- |
| Alert channel | Slack `#group-1-devops` (webhook in Secrets Manager `devops-g1/slack-webhook`) |
| Dashboards | Grafana → `TillFlow / Overview`, `TillFlow / <service>` |
| Traces | Grafana → X-Ray data source, filter by `trace_id` from the alert |
| Escalation | Area DRI (see `ownership.md`) → whole group |

### Slack alert contract (every alert must contain)

`environment` · `service` · `symptom` · `user/SLO impact` · `observed value` ·
`Grafana panel link` · `runbook link` · `owner` · `first safe action`.

### Alarm → runbook section

The lookup Meron's `alarm_description` JSON (`infra/observability.tf`) points its
`runbook link` field into — every AWS-native and burn-rate alarm from the G3 plan has a
home here before a single alarm exists, so wiring one up is "add the ARN + threshold",
never "and also go write the procedure."

| Alarm | Source | Runbook section |
| ----- | ------ | ---------------- |
| Synthetics canary `SuccessPercent` / `Duration` | CloudWatch Synthetics | [2.6](#26-external-probe-canary-failing) |
| `HTTPCode_Target_5XX_Count`, `TargetResponseTime` p95, `UnHealthyHostCount` | ALB | [2.7](#27-elevated-error-rate--latency-albapi-gateway) |
| `ApproximateAgeOfOldestMessage`, DLQ depth | SQS | [2.8](#28-queue-backlog--dlq-depth-rising) |
| CPU / memory utilization | ECS Container Insights | [2.9](#29-resource-saturation-ecscpumemory-rdscpuconnectionsstorage) |
| CPU, connections, free storage, replica health | RDS | [2.9](#29-resource-saturation-ecscpumemory-rdscpuconnectionsstorage) |
| Fast burn (14.4×/1h) / slow burn (6×/6h) per service | Metric math on the app counters in `docs/slo-error-budgets.md` | [2.10](#210-error-budget-burn-fast-or-slow) |
| Uncertain payment, callback replay, platform (cache/worker) failure, broken release, restore | App-level / manual drills | [2.1](#21-uncertain-payment-daraja-timeout)–[2.5](#25-restore-from-backup) |

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
3. For a sample charge, `POST /admin/reconcile` (service token required) — it runs
   `stkQuery` for every eligible PENDING charge and reports what each resolved to.
   `GET /admin/pending` lists what is still waiting and how many looks it has had.
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
2. `GET /admin/charges/<charge_id>/audit` (service token). It returns every callback
   received for the charge and every ledger effect it produced. Both of these must hold:
   - exactly **one** entry in `callbackEvents` has `applied: true`;
   - `outboxEvents` has exactly **one** `sale.paid` (for a PAID charge; none otherwise).
   A redelivery shows as `duplicateCount > 0` on the *same* `callbackEvents` row, not as a
   second row — that is I3 holding. (There is no `ledger_effects` table; the "ledger
   effect" of a paid charge is its `sale.paid` outbox row.)
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
1. There is no CodePipeline in this stack (`infra/pipeline.tf` was planned, never built —
   `infra/README.md`'s layout diagram is stale on this point). The real mechanism is
   `.github/workflows/deploy.yml`'s "Rollback on smoke failure" step and
   `infra/scripts/deploy.sh`'s identical local fallback: both record the pre-deploy task
   definition, and on smoke failure call `aws ecs update-service --task-definition
   <previous>` automatically — confirm it fired in the Actions log or the script's own
   output, not a CodePipeline console that doesn't exist. ECS's deployment circuit
   breaker is the backstop if that scripted step itself doesn't run.
2. Manual fallback if neither ran: `aws ecs update-service --service devops-g1-<svc>
   --task-definition <prev-revision>`.
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

### 2.6 External probe (canary) failing

**Symptom:** CloudWatch Synthetics canary `SuccessPercent` drops or `Duration` spikes —
the API is unreachable (or slow) from *outside* the VPC, which every in-VPC health check
misses by construction.
**First safe action:** check whether it's everything or one path. A canary failure with
every ECS service healthy and `/health` green from inside the VPC points at the edge
(API Gateway, VPC Link, or the ALB listener), not the services themselves.
**Steps:**
1. Grafana → uptime panel (5m/1h/28d) — confirm this isn't a single blip already recovered.
2. `aws apigatewayv2 get-apis` / check the API Gateway console for 5xx at the gateway
   itself (distinct from a 5xx the ALB or a service returned).
3. Confirm the VPC Link is `AVAILABLE`, not mid-recreation (`terraform plan` should show
   no unexpected diff there).
4. If the edge is fine but the canary's specific path 404s: check nothing renamed/removed
   that route (`infra/edge.tf`'s path-pattern rules) without updating the canary's target.
**Recovery signal:** `SuccessPercent` back to 100, `Duration` back under its threshold for
two consecutive 1-minute runs (the canary runs every ~1 min).
**Proof (G4):** break the edge deliberately (e.g. a bad listener rule), show the canary
alarm fire, fix it, show recovery in the same Grafana uptime panel.

### 2.7 Elevated error rate / latency (ALB/API Gateway)

**Symptom:** `HTTPCode_Target_5XX_Count` alarms, `TargetResponseTime` p95 breaches a
service's SLO target, or `UnHealthyHostCount` > 0.
**First safe action:** check `UnHealthyHostCount` first — if targets are unhealthy, this
is a deployment or dependency problem (go to [2.4](#24-broken-release--rollback) or
[2.9](#29-resource-saturation-ecscpumemory-rdscpuconnectionsstorage)), not a capacity one.
If all targets are healthy but slow/erroring, it's load or a downstream dependency.
**Steps:**
1. Grafana → RED row for the service — is it rate (a real traffic spike — check
   [2.6](#26-external-probe-canary-failing) hasn't also fired) or errors specifically?
2. Check saturation (CPU/memory/DB connections) for the same service — a resource-starved
   task degrades before it dies.
3. Traces (X-Ray, filter by the alarm's timeframe) — find the slow/erroring span; is it in
   our code or a downstream call (DB, Payments→Daraja, SQS)?
4. If it's a specific downstream (e.g. Daraja sandbox latency): this may not be ours to
   fix — confirm it's not masked as our SLO burn if the brief's exclusion rules apply.
**Recovery signal:** 5xx count back to baseline, p95 back under target, for one full SLO
window's worth of sustained good data (not just one data point).
**Proof (G4):** not a dedicated drill of its own — this alarm is expected to fire *during*
the broken-release drill ([2.4](#24-broken-release--rollback)) and the platform-failure
drill ([2.3](#23-platform-failure--cache-or-worker-down)); confirmed there.

### 2.8 Queue backlog / DLQ depth rising

**Symptom:** `ApproximateAgeOfOldestMessage` on `devops-g1-sale-events` or
`devops-g1-commission-payout` climbs past threshold, or either DLQ has depth > 0.
**First safe action:** a growing age means the consumer isn't keeping up or has stopped —
check the consuming task (`pos` worker for sale-events, `commission` for payout) is
actually running, not crash-looping, before assuming it's a genuine load problem.
**Steps:**
1. `aws ecs describe-services` for the consuming service — running count vs desired.
2. Logs for the consumer — is it processing (successful applies) or erroring on every
   message (which would explain both rising age AND eventual DLQ growth once
   `maxReceiveCount` is hit)?
3. DLQ depth > 0: **do not requeue blind.** Inspect a sample message first — a poison
   message (malformed body, a schema mismatch) will just DLQ again immediately if
   redriven without a fix.
4. Once the root cause is fixed, redrive DLQ → main queue
   (`aws sqs start-message-move-task` or the console's redrive).
**Recovery signal:** oldest-message-age back under threshold, DLQ depth back to 0, and
(for `sale-events` specifically) no sale stuck `UNPAID` past a reasonable window because
its `sale.paid` event was sitting in the backlog.
**Proof (G4):** break the consumer deliberately, show age/DLQ alarms fire, fix, redrive,
show recovery — this is the same drill as
[2.3](#23-platform-failure--cache-or-worker-down), just naming the specific alarms now
that they exist.

### 2.9 Resource saturation (ECS CPU/memory, RDS CPU/connections/storage)

**Symptom:** ECS Container Insights CPU/memory alarm for a service, or an RDS alarm
(CPU, connection count, free storage, or — if Multi-AZ failover fires — replica health).
**First safe action:** for ECS, check whether it's one task or the whole service (a single
hot task can mean an uneven load-balancing issue, not a real capacity shortfall). For RDS,
connection-count alarms are often a leak (a service not releasing pool connections), not
genuine query load — check `pg_stat_activity` before assuming "we need a bigger instance."
**Steps:**
1. Grafana → saturation row for the affected service/RDS.
2. ECS: `aws ecs describe-tasks` for CPU/memory per task; compare against `task_cpu`/
   `task_memory` (`infra/variables.tf`) to see actual headroom, not just the alarm's %.
3. RDS: `SELECT count(*) FROM pg_stat_activity;` grouped by application/state — an idle-
   in-transaction pile-up points at a service, not the database itself.
4. Free storage low: check for an unexpectedly large table/index (a missing retention
   policy somewhere) before just growing the volume.
**Recovery signal:** utilization back under the alarm threshold for a sustained period,
not a single reading.
**Proof (G4):** exercised as part of the k6 soak run (`k6/soak.js`) and the capacity
analysis in `evidence/reliability-ops/` — a soak is exactly what should reveal a slow
resource leak this alarm class exists to catch.

### 2.10 Error budget burn (fast or slow)

**Symptom:** a fast-burn (14.4×/1h) or slow-burn (6×/6h) composite alarm fires for a
service's SLO, per the thresholds in `docs/slo-error-budgets.md`'s "Burn-rate / budget
policy" table.
**First safe action:** fast burn = page, treat as active incident; slow burn = ticket,
investigate same day — **not** the same urgency, don't treat a slow-burn ticket like a page.
**Steps:**
1. Grafana → that service's SLO/budget panel — confirm the burn rate and remaining budget
   match what the alert claims (composite alarms can occasionally mis-fire on a metric gap).
2. Identify which underlying signal is burning budget (RED row, then the specific
   dependency/trace) — this alarm tells you *that* budget is burning, not *why*.
3. Fast burn: consider a rollback ([2.4](#24-broken-release--rollback)) before root-causing
   if a recent deploy correlates — reverting first, understanding after, is the right order
   under active burn.
4. Budget < 25% remaining (even without a burn-rate alarm firing): release freeze on that
   service per `docs/slo-error-budgets.md` — only reliability fixes and rollbacks merge.
**Recovery signal:** burn rate back under the alarm's threshold, sustained; budget-remaining
trending back up, not just flat.
**Proof (G4):** the game-day drill's whole point — produce one firing alert and one
recovery in Slack, both matching the 9-field contract, both with the panel/runbook links
in this table actually resolving.

## 3. Destroy / rebuild (G5)

Rebuild is two phases, and the order matters. ECR repositories are recreated
**empty**, so nothing can reference an image digest on the first apply.

```bash
# --- teardown -------------------------------------------------------------
make destroy                      # main stack, then bootstrap
./infra/scripts/audit.sh --cleanup   # asserts nothing devops-g1-* survives

# --- phase 1: infrastructure, no workloads --------------------------------
make bootstrap                    # tfstate bucket + DynamoDB lock
terraform -chdir=infra init
terraform -chdir=infra apply -var 'service_images={}'
```

`-var 'service_images={}'` is required on the first apply, and beats any local
`infra/terraform.tfvars` left over from before the destroy (a `-var` wins over
the auto-loaded file). Every service resolves to no image and stays at
`desiredCount 0` -- correct, because nothing has been built for this account
yet. Without it, a stale digest points at a repository that was just recreated
empty and every task fails `CannotPullContainerError`.

The file is gitignored for the same reason: an auto-loaded committed digest
would make CI's apply reintroduce exactly that failure.

```bash
# --- phase 2: first release ----------------------------------------------
./infra/scripts/deploy.sh pos     # builds, pushes, deploys by digest,
                                  # scales 0 -> 2, smokes, rolls back on failure
./infra/scripts/audit.sh          # naming + tags on the rebuilt stack
```

`deploy.sh` performs the 0 -> 2 scale-up itself: deploying is the first moment a
real image exists, so the pipeline owns that transition (Terraform sets the
initial count, then ignores it -- see the lifecycle block in `infra/ecs.tf`).
It also writes the local `terraform.tfvars` so a later `terraform apply` knows
what is running.

Expected wall-clock: to be measured in G5.
