# Delivery gates — tracker

Each gate passes with a PR + reproducible evidence. Blocked-if conditions are hard fails.

## G0 — Decide (D2)

| Item | Status | Where |
| ---- | ------ | ----- |
| Private mono-repo + mentor access | ◐ repo exists; **add mentor as collaborator** | GitHub settings |
| Ownership matrix — one DRI per area, every member cross-reviews | ☑ | `docs/ownership.md`, `CODEOWNERS` |
| Architecture | ☑ | `docs/architecture.md` |
| ADRs incl. region | ☑ 0001–0007 | `docs/adr/` |
| Threat model | ☑ | `docs/threat-model.md` |
| Draft SLOs | ☑ | `docs/slo-error-budgets.md` |
| **Blocked if:** a member has no primary area, or a critical decision has no DRI | ☑ cleared | `docs/ownership.md` DRI ledger |

### G0 remaining actions (not code)
- [x] Real GitHub handles wired into `CODEOWNERS` + `docs/ownership.md`
      (`@RigbeWeleslasie`, `@nebyathhailu`, `@meronkahsay`)
- [x] `@nebyathhailu` and `@meronkahsay` added as repo collaborators
- [x] Scaffold PR (#1) reviewed by @nebyathhailu and merged to `main`
- [x] Repo made **public** — required to enforce branch protection + CODEOWNERS on a
      free plan (private needs Pro/Team). Secret scanning + push protection are on by
      default for public repos; no real secrets in history. Logged as a deviation from
      the brief's "private" wording — pending GitHub Education / org move to restore private.
- [x] Branch ruleset `main protection` on `main`: require PR + 1 approval + require
      review from Code Owners + conversation resolution + block force-push/deletion
- [ ] Add the mentor/trainer as a collaborator (Read if on org/Pro, else Write)
- [ ] Confirm AWS account ID → note it for S3 bucket suffixes
- [ ] Create the `prod` protected environment in GitHub (reviewers = platform DRI)
- [ ] Apply for GitHub Education Pack to move the repo back to private with enforcement

## G1 — Platform (D5)
Terraform plan/apply; naming + tag audit; ECS golden path, health, sidecar boot, first
pipeline deploy. **Blocked if:** manual infra, broken naming/tags, or no repeatable deploy.

## G2 — Product (D8)
Sale → STK callback → paid; close → commission → B2C; state/idempotency tests.
**Blocked if:** happy path only, unsafe money state, or a direct Daraja call from Commission.

### Track A — Product + POS (Rigbe): status
- [x] Shared TypeScript scaffolding unblocked (`services/_shared/ts` — money/events/otel/health;
      see `docs/scar-log.md` for why this landed on Track A instead of waiting on Platform)
- [x] `services/pos` — tenant setup, sale state machine, `POST /sales` (idempotent,
      server-computed totals), `POST /sales/{id}/pay`, `GET /sales/{id}`, `sale.paid`
      consumer, migrations for `pos_*`
- [x] `services/web` — owner/attendant shell, proxies to POS, no DB of its own
- [x] I1 (idempotency) and IDOR proven with real, passing tests — 29/29 across
      `@tillflow/shared` + `@tillflow/pos` + `@tillflow/web` (`evidence/product-pos/`)
- [x] Failure-path tests alongside every success test (timeout → stays `UNPAID`,
      malformed `sale.paid` event left unacked, same-key-different-body → 409, etc.) —
      the "happy path only" blocker specifically
- [x] `GET /internal/daily-close` — the contract the Commission worker reads (per-sale
      amounts, Nairobi business day, rate + MSISDN resolved as of the close)
- [x] Integration with a real Payments service — proven, not asserted:
      `tests/integration/` wires POS and Payments together with only Daraja faked
      (the `tenantId`/`customerMsisdn` mismatch it caught is in `docs/scar-log.md`)
- [ ] Not yet done: real Postgres/RDS run (tests are pg-mem-backed only)
- [ ] Not yet done: deployed to ECS / exercised through the pipeline

### Track B — Payments + integrity (Nebyat): status
- [x] `services/payments` — sole owner of Daraja. STK push, callbacks, transaction query,
      B2C, reconciliation; charge and payout state machines; transactional outbox
      (`sale.paid`); migrations for the `payments` schema
- [x] `services/commission` — daily close: computes each attendant's commission from
      confirmed PAID sales, writes the payout ledger, requests B2C **through the Payments
      API**. No Daraja dependency of any kind
- [x] `@tillflow/mpesa` — one adapter interface, two implementations: `DarajaAdapter`
      (sandbox) and `FakeAdapter` (the deterministic scenario table, ADR 0005)
- [x] I2–I5 proven with real, passing tests — see `evidence/payments-integrity/` for the
      per-invariant table and the exact command behind every count
- [x] Failure paths beside every success path: decline, timeout, callback replay and
      reorder, amount mismatch (hold), unverifiable B2C amount, insufficient float
- [x] Both G2 flows proven across the real seams in `tests/integration/`:
      sale → STK callback → paid, and close → commission → B2C
- [ ] Not yet done: real Postgres/RDS run; Daraja sandbox credentials in
      `devops-g1/daraja` (the contract test skips without them)
- [ ] Not yet done: deployed to ECS / exercised through the pipeline

### Cross-cutting G2 blockers — status
- **Happy path only:** ☑ cleared. Every success path has a failure path beside it on both
  tracks — decline, timeout, replay, reorder, hold, unverifiable B2C amount, insufficient
  float, malformed event left unacked, same-key-different-body → 409.
- **Unsafe money state:** ☑ cleared. Integer minor units end to end; one documented
  rounding rule (`floor` per sale, then summed — `@tillflow/shared/money`); the remainder
  is carried on the ledger rather than lost, and `amount = payout + remainder` is asserted
  across the real seam. I2–I5 additionally hold as **database constraints**, independent
  of any handler (`services/payments/test/schema.test.ts`).
- **Direct Daraja call from Commission:** ☑ cleared, structurally. `@tillflow/mpesa` is not
  a dependency of `services/commission` — its deps are `shared`, `otel`, `pg`, `pino`,
  `sqs` and nothing else, so the call is not merely discouraged but impossible without a
  package change. Documented in `docs/architecture.md` §3, enforced at the IAM layer in
  `infra/iam.tf` (no Daraja secret grant), and proven in `evidence/payments-integrity/`.

### G2 — how to reproduce
```bash
npm ci && npm test        # 214 tests across 7 workspaces, 0 failing
```
Per-area detail and per-invariant commands: `evidence/payments-integrity/`,
`evidence/product-pos/`.

## G3 — Operate (D11)
Grafana uptime/SLO/budget panels; traces; k6 envelope; Slack firing/recovery.
**Blocked if:** no external probe, no per-service budget, or no actionable alert.

### Rigbe's G3 status (k6 + runbook — unblocked, no dependency)
- [x] `k6/smoke.js`, `k6/baseline.js`, `k6/spike.js`, `k6/soak.js` + `k6/lib/` written and
      **validated locally** against a real POS server + real Postgres 16 (not `pg-mem`) —
      100% checks passed, 0% `http_req_failed`, all thresholds green on every scenario
      (`evidence/reliability-ops/`)
- [x] Found + fixed a real bug while wiring k6 auth: `/dev/tokens` was silently
      unreachable in every real deployed image (`services/pos/src/plugins/auth.ts`,
      `docs/scar-log.md`)
- [x] Runbook procedures 2.6–2.10 written for every G3 alarm class (external probe,
      elevated error rate/latency, queue backlog/DLQ, resource saturation, error-budget
      burn) + an "Alarm → runbook section" index so every future
      `alarm_description.runbook_link` resolves to a real section (`docs/runbook.md`)
- [x] Queue-age-is-stack-wide caveat added to `docs/slo-error-budgets.md` (flagged by
      Meron's G3 review)
- [x] POS SLI counter — `pos_sale_write_total{result}` (`services/pos/src/metrics.ts`),
      wired into `saleService.ts`'s three real outcomes (`ok`/`idempotent`/
      `unique_violation`), asserted through the real `POST /sales` route + the real
      OpenTelemetry SDK (`services/pos/test/metrics.test.ts`), matching
      `@tillflow/payments`' merged pattern (#20). `unique_violation` isn't exercised in
      pg-mem (no real cross-transaction isolation — same documented gap as
      `idempotency.test.ts`'s race case); real-Postgres coverage is a G4 drill candidate.
- [x] `infra/observability.tf` confirmed **applied to real AWS** (not just merged) —
      `devops-g1-pos` running 2/2, all 24 planned CloudWatch alarms exist. Confirmed while
      starting G4 (`docs/gates.md` G4 section).
- [x] **"No actionable alert" cleared.** Meron proved the CloudWatch → SNS → Lambda →
      Slack pipeline end to end (`evidence/reliability-ops/slack-alerting.md`): a forced
      ALARM→OK on `devops-g1-uptime-probe-failing`, both messages carrying all nine
      `docs/runbook.md` contract fields, both a `-> 200` in the Lambda's own delivery log.
      Plumbing is Area 3's; the contract it's proving is Area 4's, which is why this line
      is here. Not yet a **timed** drill against a real induced failure — that's G4's
      game-day deliverable, not this checkbox.
- [ ] **In progress:** Grafana panels with live data — data sources now have real metrics
      to read; dashboard build spec ready (`evidence/reliability-ops/grafana-dashboard-spec.md`),
      not yet built.
- [ ] **Blocked, not started:** k6 run/analysis against a real deployed target — `pos` is
      live; `payments`/`commission`/`web` are still at `desiredCount 0`, so a full sale→pay
      flow isn't exercisable yet.

## G4 — Recover (D13)
Failure drills, DLQ recovery, broken-release rollback, restore, runbook rehearsal.
**Blocked if:** recovery asserted but not executed and timed.

### Rigbe's G4 status (full plan: `docs/g4-plan.md`)
- [x] `docs/g4-plan.md` written — ownership split (payments → Nebyat, platform → Meron,
      reliability → Rigbe), sequencing, real current-state snapshot
- [x] Real bug found + fixed while starting the drill: `pos-worker` was silently running
      the `busybox` placeholder (never cut over to a correct Terraform-registered
      revision); a stale local `infra/terraform.tfvars` nearly caused `terraform apply`
      to revert `pos`'s real deployment too. Neither applied blind — `terraform plan`
      reviewed first. Full writeup `docs/scar-log.md`.
- [x] **2.3/2.8 (worker down / DLQ backlog) — executed for real, timed.** Real sale
      created via POS's live API, real `sale.paid` message injected onto
      `devops-g1-sale-events`, worker genuinely killed and restarted. Organic alarm
      FIRING (not `aws cloudwatch set-alarm-state`) at 7m30s, RECOVERED at 5m54s after
      fix. `evidence/reliability-ops/g4-worker-down-drill.md`.
- [x] **2.10 (game-day) — done as the natural byproduct of 2.3/2.8**, per the plan's own
      design: one real firing + one real recovery Slack message, both checked against the
      9-field contract. Same evidence file.
- [x] **2.9 (resource saturation / k6 soak) — executed 2026-09-22, real target.** 15-minute
      soak (1m ramp / 15m hold / 1m down) against the live deployed edge, `payments`
      included in the flow. All thresholds green: `checks` 100%, `http_req_failed` 0%,
      `p(95)` 61ms. `evidence/reliability-ops/g4-soak-drill.md`.
      **Still open:** the Grafana saturation-panel correlation, and `baseline.js`/`spike.js`
      (G3's fuller "k6 envelope" gap) — both expected to be edge-throttle-limited rather
      than POS-limited, `docs/g4-plan.md` §7.
- [ ] **Not started, not Rigbe's to execute:** 2.1/2.2 (Nebyat), 2.4/2.5/2.6 (Meron) — see
      `docs/g4-plan.md` §2 for the ownership split and why

### Meron's G4 status (2.4, 2.5, 2.6 — platform drills)
- [x] Drill procedures written with exact commands, pre/post capture, fill-in timelines and
      rollback-if-wrong steps: `evidence/platform-delivery/g4-canary-edge-drill.md` (2.6),
      `g4-rollback-drill.md` (2.4), `g4-restore-drill.md` (2.5). **Procedures only — per
      `docs/g4-plan.md` §6 these do not count until executed and timed.**
- [x] **2.6 (external probe / edge) — EXECUTED AND TIMED, 2026-09-20.** ALB priority-10
      listener rule broken deliberately at 17:05:04Z; alarm fired on a **real** threshold
      crossing at 17:07:11Z (**detection 2m 07s**); rule restored 17:19:23Z; alarm back to
      OK 17:23:50Z (**recovery 4m 27s**). Both Slack messages were real evaluations, not
      `set-alarm-state` — CloudWatch's own `StateReason` quoted in the evidence. Throughout
      the outage ECS reported **2/2 running** and the ALB target group **`healthy healthy`**
      while the external probe read **0.0**: the blocker justifying itself. `terraform plan`
      after the drill shows no drift from it. `evidence/platform-delivery/g4-canary-edge-drill.md`.
- [ ] **2.4 (broken release / rollback) — blocked on the `prod` GitHub environment.**
      `deploy.yml`'s `release` job carries `environment: prod`, which has no required
      reviewer, so the job has never run and every deploy so far has been a manual
      `aws ecs update-service`. Configuring that reviewer (a G0 open item, platform DRI)
      unblocks this drill *and* G5's fresh-commit release. Fallback: `infra/scripts/deploy.sh`
      proves the mechanism but not the pipeline — which the write-up must say plainly.
- [x] **2.5 (restore from backup) — EXECUTED AND TIMED, 2026-09-21.** PITR restore to a new
      instance `devops-g1-restore-202609210701` started 07:01:28Z, `available` 07:21:20Z:
      **RTO 19m 52s** against the runbook's 30-minute target. Production `devops-g1` untouched.
      **Two gaps named rather than skipped:** row-count verification was blocked because the
      `devops-g1-migrate-pos` task definition had reverted to the busybox placeholder (the
      stale-tfvars-digest bug, second occurrence), so **RPO is not claimed**; and provider
      reconciliation (runbook §2.5 step 4) needs Daraja credentials that are unset.
      `evidence/platform-delivery/g4-restore-drill.md`.

## G5 — Release (D14)
Fresh-commit release, live proof, evidence pack, individual defences, cost/cleanup,
destroy/rebuild. **Blocked if:** cannot reproduce, or a member cannot defend owned work.
