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

# sidecar boot -- both containers HEALTHY, and the collector's health_check
# extension reporting ready (not merely "the process started")
aws ecs describe-tasks --cluster devops-g1 \
  --tasks "$(aws ecs list-tasks --cluster devops-g1 --service-name devops-g1-pos \
             --desired-status RUNNING --query 'taskArns[0]' --output text)" \
  --query 'tasks[0].containers[].{Name:name,Health:healthStatus,Status:lastStatus}' --output table
aws logs tail /devops-g1/pos --since 10m | grep -iE "health_check|Everything is ready"
```

```
+---------+--------+-----------+
| Health  | Name   |  Status   |
+---------+--------+-----------+
|  HEALTHY|  pos   |  RUNNING  |
|  HEALTHY|  adot  |  RUNNING  |
+---------+--------+-----------+

Health Check state change {"kind": "extension", "name": "health_check", "status": "ready"}
Everything is ready. Begin running and processing data.
```

The sidecar's `["CMD", "/healthcheck"]` probe is exec-form because the collector
image is distroless -- no shell. It also needs the collector's `health_check`
extension declared **and** listed in `service.extensions`; without both, the
endpoint does not exist and the probe fails for the life of every task. That was
the case until 15 Sep: the task kept serving (the sidecar is `essential = false`)
but the sidecar-boot signal the gate asks for was permanently red.

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

## 5b · Image scanning — fail on fixable HIGH/CRITICAL

```bash
trivy image <image> --severity HIGH,CRITICAL --ignore-unfixed --scanners vuln
# ZERO fixable HIGH/CRITICAL
```

The first scan reported 13 findings. Only two were the base OS (an openssl
advisory in libcrypto3/libssl3); the rest -- tar, pacote, sigstore,
brace-expansion, picomatch, ip-address -- were **npm's own vendored
dependencies**, being scanned inside a production image that never runs a
package manager.

Fixed at the root rather than suppressed: `apk upgrade` patches the OS packages
at build time (keeping the digest pin, which would otherwise freeze whatever CVEs
the base shipped with), and npm/yarn/corepack are deleted from the runtime stage.
Dependencies are installed in the `deps` stage and copied in, so nothing in the
runtime needs them. The findings that remain after that are real ones.

## 5c · The scan gate actually blocks

The ECR gate was corrected three times in review -- the JSON path, then a `// 0`
default that turned an unreadable scan into zero findings, then Inspector's
literal `"NotAvailable"` slipping past a `!= ""` test. Each fix was reasonable in
isolation, which is exactly why "reviewed again" stopped being good evidence.

So it is demonstrated instead, against fixtures covering every branch:

```bash
./evidence/platform-delivery/scan-gate-verify.sh
```

```
  PASS  a fixable CRITICAL must BLOCK
  PASS  fixedInVersion=NotAvailable must NOT block
  PASS  fixedInVersion empty must NOT block
  PASS  no findings must pass
  PASS  basic scan (no fixability data) must BLOCK
```

The fixtures are real `describe-image-scan-findings` shapes
(`scan-gate-fixtures/`), and `scan-gate-test.sh` replays the gate's own jq. A
change that breaks the filter now fails here rather than in a deploy.

## 5d · Service-to-service auth token

`devops-g1/service-token` guards the routes reachable through API Gateway that
should only ever be called by another service -- POS `/internal/daily-close`,
Payments `/charges`, `/payouts`, `/admin/*` (threat-model.md §3.2). Requested by
Payments in [`../payments-integrity/deployment-contract.md`](../payments-integrity/deployment-contract.md).

```bash
# exists, KMS-encrypted, and the right shape -- without printing the value
aws secretsmanager describe-secret --secret-id devops-g1/service-token \
  --query '{Name:Name,KMS:KmsKeyId}'
aws secretsmanager get-secret-value --secret-id devops-g1/service-token \
  --query SecretString --output text |
  jq -r '"length: \(.token|length)  alphanumeric: \(.token|test("^[A-Za-z0-9]+$"))"'
# length: 48  alphanumeric: true

# who can read it
for s in pos payments commission web; do
  aws iam get-role-policy --role-name devops-g1-$s-exec \
    --policy-name devops-g1-$s-exec-secrets \
    --query 'PolicyDocument.Statement[?Sid==`ReadServiceToken`].Resource' --output text
done
# pos, payments, commission: granted -- web: none
```

Terraform generates this one rather than taking it out-of-band, because all
three services must present the *same* value: a per-service secret would
guarantee drift. `web` is excluded deliberately -- it is a browser-facing shell
and never makes an authenticated service-to-service call.

The grant needs a trailing `-*`. Secrets Manager appends a random suffix to
every ARN (`...:secret:devops-g1/service-token-NPEUKn`), so an exact-match
resource matches nothing, and the failure surfaces as a task that will not start
with `AccessDenied` rather than anything naming the cause.

## 5e · Service configuration and the migration job (contract §2–§4)

`evidence/payments-integrity/deployment-contract.md` lists what Payments and
Commission need to run. All of it is applied.

```bash
# Every secret arrives with a JSON-key suffix
aws ecs describe-task-definition --task-definition devops-g1-payments --output json |
  jq -r '.taskDefinition.containerDefinitions[] | select(.name=="payments")
         | .secrets[] | "\(.name) -> \(.valueFrom | sub("^.*:secret:"; ""))"'
```

```
SERVICE_TOKEN                  -> devops-g1/service-token-NPEUKn:token::
DATABASE_URL                   -> devops-g1/payments/db-password-Vndt3I:database_url::
DARAJA_CONSUMER_KEY            -> devops-g1/daraja-KbBIbh:consumer_key::
... 7 more DARAJA_*
```

The trailing `:<key>::` is load-bearing. Without it the container receives the
whole `{"token":"..."}` JSON as its value -- worse than a crash, because the
service starts cleanly and every internal call 401s.

**Service discovery (§3).** POS calls Payments; Commission calls both. Routing
that through the internal ALB would send traffic out of a task and back for a
call that never leaves the VPC, behind the same listener the public edge uses.
Cloud Map instead: `devops-g1-pos.devops-g1.internal:8080`.

```bash
aws servicediscovery list-services --filters "Name=NAMESPACE_ID,Values=$NS" \
  --query 'Services[].Name' --output text
# devops-g1-pos  devops-g1-payments  devops-g1-commission  devops-g1-web
```

**Migration job (§4).** A standalone task definition -- `aws ecs run-task`, it
exits, nothing runs until next time. Deliberately not a pipeline stage: the job
needs the RDS master credential, and in CI the pipeline role would hold that
permission permanently. Here only `devops-g1-migrate-task` does, and only while
a task runs. It also is not per-deploy: a migration must land *before* the code
that needs it, so coupling it to a deploy is backwards.

```bash
terraform -chdir=infra output migrate_run_task_command
```

**The Daraja boundary holds at the IAM layer.** `commission` has no
`ReadDarajaCredentials` statement on either its exec or its task role -- the one
layer of the three that still holds if the code is wrong:

```bash
aws iam get-role-policy --role-name devops-g1-commission-exec \
  --policy-name devops-g1-commission-exec-secrets \
  --query 'PolicyDocument.Statement[?Sid==`ReadDarajaCredentials`]' --output text
# (empty)
```

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
