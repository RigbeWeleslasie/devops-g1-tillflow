# G5 — cost model and cleanup plan

**DRI:** Meron — Platform + delivery. Covers G5's *"cost/cleanup"* requirement.

Figures are us-east-1 on-demand list prices as of 2026-09, rounded, for a 30-day month.
They are an **estimate from the running inventory**, not a Cost Explorer reading — this is
a shared cohort account and per-group attribution is not available to us (see
"Not our spend" below).

## What is actually running

Inventory taken 2026-09-21 against the live account.

| Resource | Spec | Qty | Est. $/month | Note |
| --- | --- | --- | ---: | --- |
| **NAT Gateway** | per-AZ | 2 | **~$66** | Hourly charge alone, before data processing |
| **RDS** | `db.t4g.small`, Multi-AZ, 20 GB | 1 | **~$50** | Multi-AZ doubles the instance cost |
| **Amazon Managed Grafana** | per active editor | 1+ | **~$9 each** | No free tier; billed per *active* user per month |
| **ElastiCache** | `cache.t4g.micro` | 2 nodes | **~$25** | Replication group, 2 members |
| **ECS Fargate** | 0.5 vCPU / 1 GB | 6 tasks | **~$65** | pos ×2, payments, commission, web, pos-worker |
| **ALB** | 1 internal | 1 | **~$17** | Plus LCU charges |
| **VPC endpoints** | interface | 6 | **~$44** | ecr.api, ecr.dkr, logs, secretsmanager, ssm, ssmmessages |
| S3 / CloudWatch / SQS / Secrets | — | — | **~$10** | Small volumes at this scale |
| | | **Total** | **~$285/mo** | **~$9.50/day** |

### The two lines worth knowing

**NAT gateways are the single biggest item and the easiest to misjudge.** Two of them
(one per AZ, for availability) cost ~$66/month *before* a byte of data. The six interface
VPC endpoints exist specifically to keep ECR pulls, CloudWatch Logs and Secrets Manager
traffic off NAT — that was the right call, but note the endpoints then cost ~$44/month
themselves. Net saving is real but smaller than it looks; at capstone traffic volumes the
endpoints are close to cost-neutral and were chosen for the security boundary as much as
the bill.

**Multi-AZ RDS roughly doubles the database cost** and is the correct choice: ADR 0003
commits to it, and `docs/runbook.md` §1's "AZ failure → RPO ~0, RTO < 5 min" depends on
the synchronous standby. Worth defending as deliberate rather than quietly dropping to
save $25.

## Not our spend — do not attribute or delete

This is a **shared cohort account** (`240462142849`). A bucket listing on the `devops-g1`
prefix returns ten buckets; only five are ours:

| Bucket | Ours? |
| --- | --- |
| `devops-g1-tfstate-240462142849` | yes — the Terraform backend (`infra/backend.tf`) |
| `devops-g1-artifacts-240462142849` | yes |
| `devops-g1-logs-240462142849` | yes |
| `devops-g1-backups-240462142849` | yes |
| `devops-g1-evidence-240462142849` | yes |
| `devops-g10-tfstate-240462142849` | **no — group 10** |
| `devops-g10-artifacts-240462142849` | **no — group 10** |
| `devops-g10-logs-240462142849` | **no — group 10** |
| `devops-g10-backups-240462142849` | **no — group 10** |
| `devops-g1-iac-tfstate-new` | tagged `Group: group-1` but **not** our backend — an
  orphan from an earlier bootstrap attempt, not in our Terraform state |

**`devops-g1` is a prefix of `devops-g10`.** Any cleanup that matches on the name prefix
would delete another team's Terraform state. `infra/scripts/audit.sh` already avoids this
by reconciling against `terraform state pull` rather than matching names — a cleanup
script must use the same discipline, and a careless `aws s3 rb` loop must not be used at
all.

## Cleanup plan for G5

### Order matters

```bash
cd infra
AWS_PROFILE=devops-lab-new terraform destroy
```

Terraform destroys only what is in **its own state**, which is exactly the property that
makes it safe in a shared account: group 10's resources are not in our state and cannot be
touched by it.

### What `terraform destroy` will NOT remove

Each of these needs a deliberate decision, not a surprise on the bill:

| Left behind | Why | Action |
| --- | --- | --- |
| `devops-g1-tfstate-*` bucket + `devops-g1-tflock` table | Created by `infra/bootstrap/`, a separate root module with its own state — destroying them from the main stack would delete the state describing the thing being destroyed | Destroy last, via `infra/bootstrap`, only after the main destroy has succeeded |
| S3 bucket **contents** | `force_destroy = true` is set on `logs` and the KMS buckets, so those empty themselves; a bucket without it fails to destroy while non-empty | Confirm, do not assume |
| `devops-g1-iac-tfstate-new` | Not in any of our state | Delete by hand after confirming nothing references it |
| KMS keys | Scheduled deletion, 7-day window | Expected; note it rather than treat it as a failure |
| CloudWatch log groups with retention | Retention expiry, not destroy | Negligible cost |
| Manual restore instances | Created outside Terraform (G4 drill 2.5) | `devops-g1-restore-202609210701` already deleted |

### Pre-destroy checklist

1. **Capture all live evidence first.** Probe history, alarm states and metric series are
   *live state* — G3 and G4 evidence partly depends on them, and `terraform destroy`
   takes them with it. Commit before destroying, not after.
2. **Fix the stale-digest bug in `infra/terraform.tfvars`.** It has reverted the migrate
   task definition to the busybox placeholder at least twice (`docs/scar-log.md`), and a
   rebuild runs migrations from scratch — this is where it would hurt most.
3. **Confirm the rebuild path.** `terraform apply -var 'service_images={}'` on a fresh
   account, per the comment in `terraform.tfvars`.

### Known rebuild gap

The `sslmode` secret repair is **not** automatic. `buildAppDatabaseUrl` writes
`database_url` only when it *creates* the app role, so a rebuild that recreates the
database will write it correctly — but any path that reuses an existing role will not.
This bit both `pos` and `payments` in production and had to be patched by hand each time
(#30, #31). A destroy/rebuild should verify DB-backed routes explicitly rather than
assuming a green `/health`, which stays 200 regardless because it touches no database.

## Cost control while the project is live

- **AMG is the one to watch**: ~$9 per *active* editor per month, billed per user. Three
  admins is ~$27/month for dashboards that are read occasionally.
- Scaling all ECS services to `desiredCount 0` between work sessions saves ~$65/month and
  costs one `update-service` to undo — but note the SLI metrics and the probe stop too,
  so budget and uptime evidence goes with them.
- The NAT gateways cannot be scaled down without removing private-subnet egress
  altogether; they are a fixed cost for as long as the stack exists.
