# G4 — restore from backup drill (2.5)

**DRI:** Meron — Platform + delivery. Covers `docs/runbook.md` §2.5, whose stated G4 proof
is: *"restore into a safe target, verify RPO/RTO, reconcile, then declare."*

**Status:** EXECUTED 2026-09-21. **RTO 19m 52s** against a 30-minute target, production
untouched. Data verification was blocked mid-drill by a separate bug — recorded below
rather than glossed, because a restore nobody queried is not a proven restore.

## Confirmed capability

Checked against the live instance before planning:

| | |
| --- | --- |
| Instance | `devops-g1` |
| Multi-AZ | `true` |
| Backup retention | 7 days |
| Latest restorable time | within ~5 minutes of now (PITR is on) |

So point-in-time restore is available and the RPO claimed in `docs/runbook.md` §1
(≤ 5 min) is testable rather than aspirational.

## The rule this drill must not break

**Restore to a NEW instance. Never restore over `devops-g1`.**

`restore-db-instance-to-point-in-time` creates a separate instance; it does not touch the
source. That is the whole reason the runbook says "point a **safe target** at the restored
DB (not prod yet)". A drill that takes production down to prove production can come back
is not a drill.

## Why the runbook's reconciliation step matters

Steps 1–3 (restore, point a target at it, count rows) are the easy part. Step 4 is the one
that makes this a *money* system's restore rather than a generic database restore:

> For every `PENDING`/ambiguous charge in the restored data, run `stkQuery` against
> Daraja to get the authoritative state. Daraja is the source of truth for money moved.

A restored database is a snapshot of what **we** believed at time T. The provider kept
moving money after T. So a charge that reads `PENDING` in restored data may have settled
at Daraja minutes later — declaring recovery without reconciling would mean either
double-paying or silently losing a payment.

**Caveat for this drill:** `payments` is at `desiredCount 0` and the Daraja sandbox
credentials in `devops-g1/daraja` are unset, so the reconciliation step cannot be
executed for real today. Two honest options — pick one and say which:

- **Restore + verify + RTO now**, and record reconciliation as *designed but not
  executed*, with the reason. Partial but truthful.
- **Wait for Nebyat's `payments` deployment** and run the whole procedure including
  reconciliation. Complete, but dependent on another owner's step.

Given G4's blocker is specifically "recovery asserted but not executed", the first is
still worth doing now — an executed-and-timed restore with one named gap beats an
unexecuted drill.

## Procedure

```bash
export AWS_PROFILE=devops-lab-new
TS=$(date -u +%Y%m%d%H%M)
echo "T0 RESTORE START: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Record the RPO target: how far back are we restoring to?
aws rds describe-db-instances --db-instance-identifier devops-g1 --region us-east-1 \
  --query 'DBInstances[0].LatestRestorableTime' --output text

aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier devops-g1 \
  --target-db-instance-identifier "devops-g1-restore-$TS" \
  --use-latest-restorable-time \
  --db-subnet-group-name devops-g1 \
  --no-multi-az \
  --no-publicly-accessible \
  --region us-east-1
```

`--no-multi-az` deliberately: this is a throwaway verification target, and Multi-AZ would
double both the cost and the restore time for no benefit to the drill.

Wait for availability — this is the bulk of the RTO:

```bash
aws rds wait db-instance-available \
  --db-instance-identifier "devops-g1-restore-$TS" --region us-east-1
echo "RESTORED AVAILABLE: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

## Verification — the part that makes it real

A restored instance that nobody queries proves nothing. Attach the same security group
the migration task uses and count rows from inside the VPC:

```sql
SELECT count(*) FROM pos.sales;
SELECT max(created_at) FROM pos.sales;
SELECT count(*) FROM pos.tenants;
```

Compare against the source. **The delta is the measured RPO** — not the configured one.

Easiest execution path is a one-off ECS task on `devops-g1-migrate-pos`'s network
configuration (subnets + `sg-05a562d7801fd93f0`), overriding `DATABASE_URL` to the
restored endpoint. Note the restored instance has the **same master credentials** as the
source, so reuse `devops-g1/db` and do not put a password in a command line.

## Timeline — executed 2026-09-21 (all UTC)

| Marker | Time | Evidence |
| --- | --- | --- |
| Baseline captured | 07:00:49 | source `devops-g1`: `db.t4g.small`, Multi-AZ, 7-day retention, `LatestRestorableTime` 06:54:00 |
| **T0 — restore requested** | **07:01:28** | `restore-db-instance-to-point-in-time` returned `status: creating` |
| Restore point (PITR target) | 07:19:21 | `--use-latest-restorable-time` |
| creating → configuring-enhanced-monitoring | 07:10:16 | status poll |
| configuring → backing-up | 07:11:19 | status poll |
| **Instance available** | **07:21:20** | status poll |
| **Measured RTO** | **19m 52s** | T0 → available. Target ≤ 30 min (`runbook.md` §1) — **met** |
| Row-count verification | — | **blocked, see below** |
| Provider reconciliation | — | **not executed, see below** |
| Restored instance deleted | | see Cleanup |

Production `devops-g1` was untouched throughout: the restore created a separate instance,
which is the whole point of the runbook's "safe target" wording.

### What the 20 minutes were spent on

Nearly all of it was `backing-up` (07:11 → 07:21). Worth knowing for planning: the RTO
here is dominated by RDS taking its own first backup of the new instance, not by data
volume — this database is 20 GB allocated with a few hundred rows. A larger database
would not be proportionally slower to restore, but nor is 20 minutes a floor that can be
tuned away by making the data smaller.

## Two things that did not get verified, and why

**Row counts / measured RPO — blocked by a second bug.** The plan was to run a one-off
task on `devops-g1-migrate-pos`'s network configuration to query the restored endpoint
from inside the VPC. That task definition had reverted to the **busybox placeholder**:

```
runc create failed: unable to start container process:
error during container init: exec: "node": executable file not found in $PATH
```

This is the `infra/terraform.tfvars` stale-digest problem resurfacing — the committed
tfvars pins an old image, so a `terraform apply` by anyone without the current digest
rewrites the migrate task definition back to busybox. It has now done this at least
twice (see `docs/scar-log.md`).

So the RTO figure is real and measured; **the RPO figure is not, and is not claimed.**
What was verified at the RDS level: the restored instance reports `available`, the same
20 GB allocation as the source, and an `InstanceCreateTime` inside the PITR window.
That establishes the restore mechanism works. It does not establish that the rows are
what we expect, which is the part that matters in a real recovery.

**Provider reconciliation (runbook §2.5 step 4) — not executed.** Reconciling `PENDING`
charges against Daraja requires sandbox credentials in `devops-g1/daraja`, which are
unset (`docs/gates.md` G2). This is the step that distinguishes a money system's restore
from a generic one: restored data is a snapshot of what *we* believed at time T, while
the provider kept settling payments after T. Declaring recovery without it risks
double-paying or silently dropping a payment.

Both gaps are named rather than skipped, per `docs/g4-plan.md` §6's rule that a drill
counts only when it has actually been executed.

## Cleanup — do not skip

A forgotten `db.t3` instance is the most expensive thing anyone can leave behind, and
G5 has an explicit cost/cleanup requirement:

```bash
aws rds delete-db-instance \
  --db-instance-identifier "devops-g1-restore-$TS" \
  --skip-final-snapshot --delete-automated-backups --region us-east-1
```

Then confirm it is gone, and that `terraform plan` still reports **No changes** — the
restored instance was created outside Terraform and must not appear in state.
