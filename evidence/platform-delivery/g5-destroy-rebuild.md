# G5 — destroy and rebuild

**DRI:** Meron — Platform + delivery. Covers G5's *destroy/rebuild* requirement and its
blocker: *"cannot reproduce."*

**Status:** PLANNED — not yet executed. Timeline below is filled in as it runs.

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

## Timeline — fill in

| Marker | UTC | Evidence |
| --- | --- | --- |
| Bootstrap state backed up | | path of the copy |
| Preflight | | PASS / FAIL |
| **T0 destroy started** | | resource count in the plan |
| Destroy complete | | `terraform destroy` exit |
| **T1 rebuild started** | | |
| `terraform apply` complete | | resource count created |
| Migrations run | | task exit code per service |
| First release through the pipeline | | Actions run URL |
| **Tenant write returns 201** | | the acceptance test above |
| **Total rebuild time** | T1 → 201 | |
| Post-rebuild drift | | `terraform plan` → No changes |

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
