# G5 — destroy and rebuild

**DRI:** Meron — Platform + delivery. Covers G5's *destroy/rebuild* requirement and its
blocker: *"cannot reproduce."*

**Status:** EXECUTED 2026-09-24. Destroyed 286 resources, rebuilt 286, and a tenant write
returned **201** against a brand-new database through a brand-new edge — with neither of
the two bugs that had been hand-patched on the old stack recurring.

## What this has to prove

That the whole stack can be torn down and rebuilt from the repository, and that the
rebuilt stack **works** — not merely that `terraform apply` exits 0. A rebuild where
`/health` answers 200 but no database-backed route does is the exact failure this project
has already hit twice, and `/health` touches no database, so it stays green through it.

So the acceptance test is the money path, not the health check.

## Pre-flight — five things to check first

**1. The bootstrap state is LOCAL and untracked.**

`infra/bootstrap/terraform.tfstate` is a real file on this machine, gitignored
(`.gitignore:19`). It is the only record of the state bucket, its KMS key and the lock
table — the resources the main stack's backend depends on. It is not in S3, because it
is what creates S3.

**Lose that file and the bootstrap resources become unmanageable**: Terraform would try
to create a bucket that already exists, and the only ways out are `terraform import` or
deleting them by hand. Back it up off this machine before anything else:

```bash
cp infra/bootstrap/terraform.tfstate ~/tillflow-bootstrap-state-$(date -u +%Y%m%d).json
```

**2. 326 resources are in the main state.** `terraform destroy` acts only on those, which
is what makes it safe in a shared cohort account — group 10's resources are not in our
state and cannot be touched. **Do not** write a cleanup loop matching `devops-g1*`:
`devops-g1` is a prefix of `devops-g10` (`g5-cost-and-cleanup.md`).

**3. All five S3 buckets have `force_destroy = true`.** Verified in `storage.tf` — the
three KMS buckets via `for_each`, plus `logs`. A bucket without it fails to destroy while
non-empty, so this is the difference between a clean destroy and a half-finished one.

**4. Run the preflight.** A stale local `infra/terraform.tfvars` silently reverts task
definitions on a bare apply — it has done so twice (`docs/scar-log.md`):

```bash
./infra/scripts/preflight.sh
```

**5. Capture live state.** Already done — `pre-destroy/`. Probe history, alarm inventory
and the Slack delivery log do not survive a destroy.

## Destroy

```bash
cd infra
export AWS_PROFILE=devops-lab-new
echo "T0 DESTROY: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
terraform destroy
```

Read the plan before confirming. Expect ~326 resources. Two that will look alarming and
are not:

- **KMS keys** go to *scheduled deletion* (7-day window), not immediate deletion. That is
  AWS's minimum and is expected.
- **RDS** has `skip_final_snapshot` behaviour to confirm in the plan — a final snapshot
  would outlive the destroy and keep costing.

Leave `infra/bootstrap` alone for now. Destroying the state bucket while the main destroy
is running removes the state describing what is being destroyed.

## Rebuild

```bash
cd infra
echo "T1 REBUILD: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
terraform init
terraform apply -var 'service_images={}'
```

`-var 'service_images={}'` is not optional on a fresh account and is the documented first
apply (`terraform.tfvars` header). A digest inside an ECR repository *this same apply
creates* does not exist yet, so any service pinned to one fails with
`CannotPullContainerError`. Empty means "use the public bootstrap image", every service
starts at `desiredCount 0`, and the pipeline scales them up by deploying.

Then, per service, in this order:

```bash
# 1. migrations — creates the app role AND writes database_url to Secrets Manager
aws ecs run-task --cluster devops-g1 --task-definition devops-g1-migrate-pos \
  --launch-type FARGATE --network-configuration '...' --region us-east-1

# 2. release through the pipeline, not by hand
#    Actions -> Deploy -> Run workflow -> service: pos, then approve prod TWICE
```

## The known gap — verify, do not assume

`buildAppDatabaseUrl` writes `database_url` **only when it creates the app role**. On a
true fresh rebuild the role does not exist, so it is created and the URL is written
correctly *with* `sslmode` — this should work.

But if anything reuses an existing role, the secret is never rewritten and every
DB-backed route returns 500 while `/health` stays 200. That is exactly what happened to
`pos` (#30) and `payments` (#31) and had to be patched by hand both times.

**So the rebuild is not "done" when apply exits 0.** It is done when this returns 201:

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"name":"Rebuild Check","tillNumber":"174379","ownerExternalAuthId":"rebuild-1","ownerDisplayName":"Rebuild"}' \
  "$(aws apigatewayv2 get-apis --query "Items[?Name=='devops-g1'].ApiEndpoint | [0]" --output text)/api/pos/tenants"
```

A tenant write exercises the edge, the prefix strip, the app, TLS to RDS and the schema
in one call. `/health` proves none of them.

## Timeline — executed 2026-09-24 (all UTC)

| Marker | Time | Evidence |
| --- | --- | --- |
| Bootstrap state backed up | 15:36 | `~/tillflow-bootstrap-state-20260924-1536.json`, 12 resources |
| Preflight | 15:38 | **FAILED** — stale local tfvars for all four services. Backed up and removed; re-ran PASS |
| Pre-destroy snapshot | 15:38:06 | 326 state entries, `/api/pos/ready` and `/api/payments/ready` both 200 |
| **T0 destroy started** | **15:38** | plan: **286 to destroy** |
| Destroy failed partway | ~16:05 | 6 errors — see below |
| Destroy complete after recovery | **~16:35** | `Destroy complete! Resources: 8 destroyed` (final pass) |
| Post-destroy verified | 16:36:08 | state 0, VPC gone, RDS gone, API Gateway gone; **state bucket + lock table alive** |
| **T1 rebuild started** | **~16:43** | `terraform apply -var 'service_images={}'` |
| RDS created | — | 15m48s, the single longest resource |
| Apply complete | ~17:00 | **286 added, 0 changed, 0 destroyed** |
| Pipeline release (`pos`) | 17:34 | image pushed to an empty ECR, service 2/2 |
| Edge verified | 17:34 | `/api/pos/health`, `/ready`, `/version` all 200, sha `45ef7af` |
| Terraform apply with real digest | ~17:37 | migrate/service/worker task definitions get the real image |
| Migration run | 17:39:06 | exit 0 — `Created role devops-g1-pos-app`, both migrations applied |
| POS restarted | 17:41 | to pick up the rewritten secret |
| **Acceptance test: tenant write** | **17:44:32** | **HTTP 201**, tenant `3592050b-85de-4e9b-8399-342960fe4d35` |

**Destroy: ~57 minutes** (including recovery from the partial failure).
**Rebuild to a working money path: ~62 minutes** (T1 16:43 → 201 at 17:44).

### New identifiers — the old ones are dead

| | Before | After |
| --- | --- | --- |
| API Gateway | `k0lzgyvn1i` | **`ayh1c5n3xd`** |
| Grafana workspace | `g-abb9c4666f` | **`g-c15263f8a5`** |
| VPC | `vpc-09055d96a1e5d9d62` | **`vpc-0fb9ba058bfb9507e`** |

Anything quoting the old API endpoint — k6 commands, earlier evidence docs — is now stale
in its *literal URL* while remaining correct in method.

## The destroy was not one-shot

Six errors on the first pass, from **two** root causes:

**One orphaned ECS task.** A `commission` task started 2026-09-20 was still `RUNNING`
after its service had been destroyed. It held `eni-07d43be00fb656d93`, which blocked the
subnet, which blocked the security group, which blocked the cluster — four of the six
errors from one straggler. Fixed with `aws ecs stop-task`.

**Four non-empty ECR repositories.** `RepositoryNotEmptyException` — Terraform will not
delete a repository containing images without `force_delete`. Emptied with
`batch-delete-image`.

Re-running `terraform destroy` then completed the remaining 8 resources cleanly.

Worth keeping rather than smoothing over: **a destroy of a stack that has been running
real workloads is not a single command**, and the failure modes are orphaned tasks and
non-empty registries. A drill that succeeded first time would not have shown that.

## Both hand-patched bugs stayed fixed

This is the part that makes the rebuild meaningful rather than ceremonial. Two bugs were
patched **by hand** on the old stack and could easily have lived only in shell history:

**Edge prefix strip** — worked immediately, no intervention. `/api/pos/health`, `/ready`
and `/version` all returned 200 on the first release.

**`sslmode` in the app database URL** — written automatically. The migration log says why:

```
Created role devops-g1-pos-app.
apply 001_init.sql
apply 002_whole_shilling_prices.sql
Wrote password + database_url to Secrets Manager: devops-g1/pos/db-password
Migration complete.
```

`buildAppDatabaseUrl` writes the URL only when it **creates** the role. On a fresh
database the role does not exist, so it is created and the URL is written correctly:

```
sslmode=require&options=-c+search_path%3Dpos%2Cpublic
```

That is the fix proven to live in the code, not in someone's terminal.

## One step the runbook was missing

**A rebuild needs an extra service restart after migrations.** ECS injects secrets at task
start, so the first generation of tasks holds Terraform's *placeholder* `database_url`.
Before the restart the acceptance test failed with:

```
{"code":"ENOTFOUND","message":"getaddrinfo ENOTFOUND base"}
```

`base` is the literal placeholder hostname. `/health` and `/ready` stayed **200**
throughout, because neither touches the database — the same shape as the two bugs above,
and the reason the acceptance test is a tenant write rather than a health check.

After `aws ecs update-service --force-new-deployment`, the tenant write returned 201.

## Post-rebuild state

| | |
| --- | --- |
| Resources | 286 created, matching 286 destroyed |
| Alarms | **32** (30 metric + 2 composite) — the full set |
| External probe | reporting **100.0** on every minute |
| Money path | tenant write **201** |
| `terraform plan` | 3 task-definition replacements — the known placeholder-vs-digest churn, not drift from the rebuild |

## What "reproducible" honestly means here

The infrastructure reproduces. The **operational history does not**: the rebuilt probe
starts with no metric history, the alarms exist again but have never fired, and the Slack
delivery log is gone. `pre-destroy/` exists precisely so that difference is visible rather
than quietly re-captured and presented as continuous.

Worth saying out loud at defence, because it is the honest shape of the claim.

## Cleanup after — what destroy does not remove

| Left behind | Why | Action |
| --- | --- | --- |
| `devops-g1-tfstate-*` + `devops-g1-tflock` | created by `infra/bootstrap`, separate state | destroy last, from `infra/bootstrap`, only if tearing down for good |
| `devops-g1-iac-tfstate-new` | orphan from an earlier bootstrap, in no state | delete by hand |
| KMS keys | 7-day scheduled deletion | expected, note it |
| ECR images | repository policy | go with the repo |
