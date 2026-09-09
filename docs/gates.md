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
      (`@RigbeWeleslasie`, `@nebyathhailu`, `@meronkhasay`)
- [ ] Add `@nebyathhailu` and `@meronkhasay` as repo collaborators
- [ ] Make the GitHub repo **private**; add mentor with read/triage access
- [ ] Enable branch protection on `main`: require PR, 1 review, require review from
      Code Owners, require status checks, no direct pushes
- [ ] Confirm AWS account ID → note it for S3 bucket suffixes
- [ ] Create the `prod` protected environment in GitHub (reviewers = platform DRI)
- [ ] Open the `g0-decide` PR and get it reviewed/merged before D2

## G1 — Platform (D5)
Terraform plan/apply; naming + tag audit; ECS golden path, health, sidecar boot, first
pipeline deploy. **Blocked if:** manual infra, broken naming/tags, or no repeatable deploy.

## G2 — Product (D8)
Sale → STK callback → paid; close → commission → B2C; state/idempotency tests.
**Blocked if:** happy path only, unsafe money state, or a direct Daraja call from Commission.

## G3 — Operate (D11)
Grafana uptime/SLO/budget panels; traces; k6 envelope; Slack firing/recovery.
**Blocked if:** no external probe, no per-service budget, or no actionable alert.

## G4 — Recover (D13)
Failure drills, DLQ recovery, broken-release rollback, restore, runbook rehearsal.
**Blocked if:** recovery asserted but not executed and timed.

## G5 — Release (D14)
Fresh-commit release, live proof, evidence pack, individual defences, cost/cleanup,
destroy/rebuild. **Blocked if:** cannot reproduce, or a member cannot defend owned work.
