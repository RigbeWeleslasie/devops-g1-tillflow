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
- [ ] **In progress:** Grafana panels with live data — data sources now have real metrics
      to read; dashboard build spec ready (`evidence/reliability-ops/grafana-dashboard-spec.md`),
      not yet built.
- [ ] **Blocked, not started:** k6 run/analysis against a real deployed target — `pos` is
      live; `payments`/`commission`/`web` are still at `desiredCount 0`, so a full sale→pay
      flow isn't exercisable yet.

## G4 — Recover (D13)
Failure drills, DLQ recovery, broken-release rollback, restore, runbook rehearsal.
**Blocked if:** recovery asserted but not executed and timed.

## G5 — Release (D14)
Fresh-commit release, live proof, evidence pack, individual defences, cost/cleanup,
destroy/rebuild. **Blocked if:** cannot reproduce, or a member cannot defend owned work.
