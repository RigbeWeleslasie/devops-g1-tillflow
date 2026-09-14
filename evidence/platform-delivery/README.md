# evidence/platform-delivery

**DRI:** Meron — Platform + delivery · **Gate:** G1 (Platform)

Every claim below is reproducible from a clean clone with only `AWS_PROFILE` set.
Screenshots earn no credit; the commands are the evidence.

```bash
export AWS_PROFILE=devops-lab-new   # NOT `default` -- that is a different account
aws sts get-caller-identity         # expect Account 240462142849
```

---

## Index

| # | What is proven | Command | Artifact |
| - | -------------- | ------- | -------- |
| 1 | Remote state with locking | `make bootstrap` | [state-backend.md](state-backend.md) |
| 2 | Repeatable apply, no drift | `make plan` / `make apply` | [terraform-lifecycle.md](terraform-lifecycle.md) |
| 3 | Naming + tag audit passes | `./infra/scripts/audit.sh` | [audit.md](audit.md) |
| 4 | ECS golden path + ADOT sidecar boot | `./infra/scripts/deploy.sh pos` | [golden-path.md](golden-path.md) |
| 5 | Release by immutable digest | `./infra/scripts/smoke.sh pos <sha>` | [release-identity.md](release-identity.md) |
| 6 | Account guard blocks the wrong account | `AWS_PROFILE=default make plan` | [account-guard.md](account-guard.md) |

---

## 1 · Remote state (S3 + KMS + DynamoDB lock)

ADR 0004. The state bucket is versioned, SSE-KMS with a customer-managed key,
all four public-access blocks on, and TLS-only by bucket policy. The DynamoDB
table serialises concurrent applies so CI and a laptop can never both write.

```bash
make bootstrap                       # one-time, local state
aws s3api get-bucket-versioning  --bucket devops-g1-tfstate-240462142849
aws s3api get-bucket-encryption  --bucket devops-g1-tfstate-240462142849
aws s3api get-public-access-block --bucket devops-g1-tfstate-240462142849
aws dynamodb describe-continuous-backups --table-name devops-g1-tflock
```

**Scar:** the first apply failed to write state — the bucket policy denied
Terraform's own uploads. Root cause and fix in
[`docs/scar-log.md`](../../docs/scar-log.md) (2026-09-14).

## 2 · Terraform lifecycle

```bash
make plan                            # review
make apply                           # apply
terraform -chdir=infra plan -detailed-exitcode   # 0 = no drift
```

`-detailed-exitcode` returning **0** is the proof that state and reality agree —
a stronger claim than "apply succeeded", and the check CI runs on every PR.

## 3 · Naming + tag audit (the G1 gate check)

```bash
./infra/scripts/audit.sh             # exit 0 = pass
./infra/scripts/audit.sh --cleanup   # after destroy: asserts nothing remains
```

Asserts every resource carries the six required tags (`group`, `owner`,
`environment`, `service`, `managed-by=terraform`, `capstone=tillflow`) and a
`devops-g1` name. Resources addressed by generated id (EC2, API Gateway, ACM,
KMS) are checked via their `Name` tag or alias, since their ARN cannot carry a
prefix.

**The audit can fail**, which took two attempts to get right. Filtering on
`--tag-filters capstone=tillflow` meant an untagged resource was never returned,
so the audit could not fail on the one condition it exists to check. Selecting by
name prefix instead was worse on a **shared cohort account** — another team runs
a `devops-g1-iac-*` stack here, and their untagged resources were reported as our
violations.

It now reconciles against `terraform state pull`: authoritative about what this
stack owns, regardless of tags, and blind to other teams' similar names.
Verified by injecting a resource with missing `owner`/`service` and an unprefixed
`Name` — the audit failed on both, as intended.

## 4 · ECS golden path and ADOT sidecar

Every task runs two containers: the application and an ADOT Collector sidecar
exporting OTLP → CloudWatch/X-Ray.

```bash
./infra/scripts/deploy.sh pos

# tasks running, both targets healthy, one per AZ
aws ecs describe-services --cluster devops-g1 --services devops-g1-pos \
  --query 'services[0].[desiredCount,runningCount]' --output text
aws elbv2 describe-target-health --target-group-arn "$(aws elbv2 \
  describe-target-groups --names devops-g1-pos \
  --query 'TargetGroups[0].TargetGroupArn' --output text)" \
  --query 'TargetHealthDescriptions[].{IP:Target.Id,State:TargetHealth.State}' --output table

# sidecar boot
aws logs tail /devops-g1/pos --since 10m | grep -i "Everything is ready"
```

`/health` is liveness (ECS) and `/ready` is readiness (ALB) — deliberately
different: a task that is alive but draining must leave the load balancer
without ECS restarting it.

## 5 · Release identity — SHA and digest, never `latest`

ECR repositories are `IMMUTABLE`, so a pushed tag can never be repointed. Images
are tagged with the commit SHA; what is deployed is the **digest** that tag
resolves to.

```bash
./infra/scripts/smoke.sh pos "$(git rev-parse HEAD)"
```

The smoke test asserts `/version.sha` equals the commit that was built — a deploy
that "succeeded" while leaving the previous image running fails here. The
pipeline rolls back to the previous task definition on that failure.

## 6 · Account guard

The workstation's `default` profile points at an unrelated account. The provider
pins `allowed_account_ids`, so a wrong or forgotten profile fails before it
creates anything:

```bash
AWS_PROFILE=default terraform -chdir=infra plan
# Error: AWS account ID not allowed: 328419555122
```

---

## Public edge — working end to end

```
$ ./infra/scripts/deploy.sh pos
digest  : sha256:5ce8952c84939380379c0e3355b5ff55ab4e3e78ee44d0e18e8c33f26faef9cf
registered: arn:aws:ecs:us-east-1:240462142849:task-definition/devops-g1-pos:6
smoking https://k0lzgyvn1i.execute-api.us-east-1.amazonaws.com/pos

PASS  /health   {"status":"ok","service":"pos"}
PASS  /ready    {"status":"ready","service":"pos"}
PASS  /version  {"service":"pos","sha":"33a8a119b6481e18fea7baceb6338dc8e6cb0eb4",
                 "digest":"sha256:5ce8952c8493...","environment":"prod"}

SMOKE PASSED — pos
DEPLOYED  pos  33a8a11  sha256:5ce8952c8493...
```

`/version` reports the commit **and** the immutable digest of the running image,
read back through the public edge — the artifact-identity evidence the brief asks
for. The smoke test asserts the returned SHA equals the commit that was built, so
a deploy that silently left the old image running fails and rolls back.

Getting here took two stacked faults, both written up in
[`docs/scar-log.md`](../../docs/scar-log.md) (2026-09-15): a VPC Link security
group with no ingress rule, and a `tls_config` that AWS would not let Terraform
remove.
