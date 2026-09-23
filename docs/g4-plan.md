# G4 (Recover) — plan

- **DRI:** Rigbe (Reliability + operations) — this plan; each drill's execution is owned
  per the table below.
- **Gate:** *"Failure drills, DLQ recovery, broken-release rollback, restore, runbook
  rehearsal."* **Blocked if:** recovery asserted but not executed and timed
  (`docs/gates.md`).
- **What "done" means here:** every row in §2 has a real timestamp, not a checkmark. A
  drill that was *discussed* or *asserted* does not clear this gate — only one that was
  *run against the real system and timed* does.

## 1. Why a plan, not just the runbook

`docs/runbook.md` already has the 10 procedures (§2.1–2.10) and what "Proof (G4)" means
for each — that document answers "what do we do when this alarm fires." This one answers
a different question: **who runs which drill, in what order, against what, and how do we
know it's actually done.** Read them together; don't duplicate one into the other.

## 2. Ownership and status

G4 is a whole-team gate, but each procedure sits in one person's domain by code and
access, and G5's "a member cannot defend owned work" blocker means the domain owner has
to be the one who actually runs their own drill — not have Rigbe run it for them.

| # | Procedure | Owner | Depends on | Status |
| - | --------- | ----- | ---------- | ------ |
| 2.1 | Uncertain payment (Daraja timeout) | **Nebyat** | `payments` deployed | not started |
| 2.2 | Callback replay / reorder | **Nebyat** | `payments` deployed | not started |
| 2.3 / 2.8 | Platform failure — worker down / DLQ backlog | **Rigbe** | `pos-worker` deployed (✅ 2026-09-19) | ✅ **done 2026-09-20** — real backlog, real alarm, timed 7m30s detect / 5m54s recover (`evidence/reliability-ops/g4-worker-down-drill.md`) |
| 2.4 | Broken release — rollback | **Meron** | any service deployed | not started |
| 2.5 | Restore from backup | **Meron** | none (RDS is already up) | not started |
| 2.6 | External probe (canary) failing | **Meron** | canary live (✅ confirmed) | not started |
| 2.7 | Elevated error rate/latency | — | n/a | not a dedicated drill — covered by 2.3 and 2.4 (`runbook.md`'s own note) |
| 2.9 | Resource saturation | **Rigbe** | `pos` deployed (✅), full flow for soak | ✅ **soak done 2026-09-22** — 15-min k6 soak vs. the deployed target, all thresholds green, no leak (`evidence/reliability-ops/g4-soak-drill.md`). Grafana panel correlation and the baseline/spike half of the k6 envelope still open — see §7 |
| 2.10 | Error budget burn / game-day | **Rigbe** | 2.3/2.8 landing cleanly | ✅ **done 2026-09-20** — same drill as 2.3/2.8 produced it, per §5's own plan (`evidence/reliability-ops/g4-worker-down-drill.md`) |

Rigbe's own minimum personal proof (`docs/ownership.md`, Area 4), independent of the
table above: a Grafana dashboard export, a k6 analysis with the highest sustained RPS,
and one timed game-day drill with a firing + recovery Slack alert. The game-day drill is
✅ done (see above). Grafana export and k6-against-real-target are still open.

## 3. Current real state (as of 2026-09-19, updated mid-session — re-check before trusting this)

Confirmed via `aws ecs describe-services` / `aws cloudwatch describe-alarms`, not assumed:

| Service | Desired | Running |
| ------- | ------- | ------- |
| `pos` | 2 | 2 |
| `pos-worker` | 1 | 1 — fixed 2026-09-19, was silently running `busybox` (`docs/scar-log.md`) |
| `payments` | 0 | 0 |
| `commission` | 0 | 0 |
| `web` | 0 | 0 |

- `infra/observability.tf` **is applied** — all 24 planned CloudWatch alarms exist for
  real, not just merged as source.
- The CloudWatch → SNS → Lambda → Slack pipeline **is proven end to end** — a real forced
  ALARM→OK on `devops-g1-uptime-probe-failing`, both messages carrying the full 9-field
  contract (`evidence/reliability-ops/slack-alerting.md`). Alerts now land in
  `#group-1-devops`, not the cohort-wide channel that evidence file originally shows.
- A real bug (`fix/pos-rds-sslmode`) blocked every DB-backed POS route until just now:
  `buildAppDatabaseUrl` dropped `sslmode=require`, RDS refused the connection. Fixed;
  confirm the fix is deployed before trusting any `pos` DB-backed drill result.
- Found while checking readiness, not manufactured: the `commission-payout` SQS queue had
  4 real `daily_close` trigger messages from EventBridge Scheduler, oldest ~3.6 days
  (4-day retention) — `commission` has never been deployed to consume them. A `commission`
  deploy was started to clear this for real; **confirm it finished** before assuming this
  is resolved.

Re-run the two `aws` commands above before starting any drill — this table goes stale the
moment anyone deploys anything.

## 4. Sequencing

Not everything can start at once; this is the order that avoids drilling against a target
that isn't actually there yet.

1. **Confirm the blockers in §3 are actually cleared** — `commission` deploy finished,
   `fix/pos-rds-sslmode` merged and redeployed. Nothing below is trustworthy until this is
   true.
2. **Rigbe: 2.3/2.8 (worker-down/DLQ drill)** — needs `pos-worker` deployed (currently 0),
   otherwise nothing to scale down from. No other DRI's domain, start as soon as deployed.
3. **Rigbe: Grafana dashboards** (`evidence/reliability-ops/grafana-dashboard-spec.md`) —
   buildable in parallel with step 2, doesn't depend on it.
4. **Rigbe: k6 soak** — needs `payments` deployed too for a full sale→pay flow, not just
   `pos`. Blocked until Nebyat's `payments` deploy lands (step 6).
5. **Meron: 2.6 (canary/edge)** — no dependency beyond what's already live, can run
   anytime.
6. **Nebyat: `payments` deploy, then 2.1/2.2** — unblocks step 4 as a side effect.
7. **Meron: 2.4 (rollback) and 2.5 (restore)** — no dependency, can run anytime, but 2.4
   is more informative once at least two services are live to pick from.
8. **Rigbe: 2.10 game-day** — the natural byproduct of step 2 done cleanly (§5). Last,
   since it's the thing G5's individual defence leans on most.

## 5. The game-day drill (2.10) in detail

This is deliberately not a separate failure from 2.3/2.8 — manufacturing a *second* one
just to have a dedicated "game day" would be theater. The real plan:

1. Run 2.3/2.8 for real: scale `devops-g1-pos-worker` to 0, generate sale traffic (a short
   `k6 smoke.js` run), let `sale.paid` events back up on `devops-g1-sale-events` until the
   queue-age alarm fires.
2. Capture the FIRING Slack message the moment it lands — screenshot or copy the raw text,
   same as `evidence/reliability-ops/slack-alerting.md` did for the forced-state version,
   except this one is a **real** alarm evaluation, not `set-alarm-state`.
3. Scale the worker back up, confirm the backlog drains, capture the RECOVERED message.
4. Check both messages against the 9-field contract (`docs/runbook.md` §0) and confirm the
   `grafana`/`runbook` links in the message actually resolve to something real.
5. Record start (worker scaled to 0) → recovery-signal (backlog at 0, alarm OK) as the
   timed duration. This number is the "timed" half of the gate's blocked-if.
6. Write it up in `evidence/reliability-ops/` next to the existing k6 and Slack evidence,
   and add a `docs/scar-log.md` entry for anything the drill reveals that wasn't already
   known (a slower-than-expected drain, an unexpected duplicate, anything).

## 6. Definition of done

- Every row in §2 has a real date next to it, not "not started."
- `docs/runbook.md`'s status line no longer says "None are rehearsed + timed yet."
- `evidence/reliability-ops/` has a timed record for each Rigbe-owned drill, and links to
  Nebyat's/Meron's equivalents for theirs.
- The Grafana export and k6 analysis (Rigbe's personal minimum proof) exist as committed
  artifacts, not just a live dashboard someone would have to log in to see.
- `docs/gates.md`'s G4 section reflects all of the above, in the same checklist style
  used for G3.

## 7. The k6 envelope (2.9's other half, and G3's own gap)

The all-gates review (2026-09-22) named this directly: G3's "k6 envelope" needs
`baseline.js` (finds the knee / highest sustained RPS) and `spike.js` (burst recovery) run
against the deployed target, not just `soak.js`. Status:

- **`soak.js` — done 2026-09-22**, §2's table and `evidence/reliability-ops/g4-soak-drill.md`.
- **`baseline.js` and `spike.js` — not yet run.** Both cross the live 50 rps API Gateway
  throttle (`docs/g4-edge-throttle-caveat`, `k6/README.md`) well before POS's own limit
  would show up — baseline's default steps reach 100 VUs, spike hits 100 VUs by design.
- **Decision (2026-09-22): run them as-is against the live throttle and report the result
  as edge-limited, rather than asking Meron to raise the throttle for a test window.** No
  infra change, no coordination cost, no risk to the shared environment — the tradeoff is
  that the knee these two runs find is the throttle's, not POS's own capacity ceiling. That
  is still real, useful information (`docs/g4-edge-throttle-caveat` records the reasoning);
  it should be written up as such, not presented as POS's actual limit.
