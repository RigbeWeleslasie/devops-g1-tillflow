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

**The audit can fail.** It selects resources by tag **or** name prefix, so an
untagged `devops-g1-*` resource is still returned and still flagged — an earlier
version filtered on `capstone=tillflow` first and so could never fail on the
condition it exists to catch. Verified by injecting a resource with missing
`owner`/`service` and an unprefixed `Name`; the audit failed on both, as intended.

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

## Known issue — public edge

`API Gateway → VPC Link → internal ALB` returns 503 and the ALB's
`RequestCount` stays 0, so traffic never arrives. Everything behind that hop is
healthy: tasks running, targets healthy, `/health` `/ready` `/version` correct.

Ruled out by inspection: the SG chain on both sides (VPC Link ENIs confirmed
carrying the expected SG), NACLs, subnet/AZ placement, integration URI and
ConnectionId, listener rules, `payload_format_version` (1.0 is required for
HTTP_PROXY — AWS rejects 2.0), and TLS. One real bug was found and fixed on the
way: the VPC Link SG had no ingress rule at all.

Next step: curl the ALB from inside the VPC to isolate whether the ALB answers.
