# infra — Terraform

**DRI:** Meron (Platform + delivery)

All AWS infrastructure, pipelines, alarms and dashboards. Nothing is created by hand —
console changes earn no evidence credit.

## Layout (built out in G1)
```
infra/
├─ bootstrap/        # one-time: tfstate S3 bucket + DynamoDB lock + state KMS key (local state)
├─ versions.tf       # required_providers + required_version
├─ providers.tf      # aws provider, region, default_tags
├─ backend.tf        # S3 backend (points at bootstrap outputs)
├─ variables.tf
├─ locals.tf         # name_prefix, common tags
├─ network.tf        # VPC, 2 private + 2 public subnets, NAT, endpoints
├─ data.tf           # RDS (Multi-AZ), RDS Proxy, ElastiCache, SQS+DLQ, EventBridge
├─ ecs.tf            # cluster devops-g1, 4 services, task defs (app + ADOT sidecar)
├─ edge.tf           # API Gateway HTTP API, VPC Link, internal ALB, access logs
├─ iam.tf            # ci-deploy (OIDC), pipeline, codebuild, per-service task/exec roles
├─ secrets.tf        # Secrets Manager references: daraja, slack-webhook, db
├─ pipeline.tf       # CodeConnections + CodePipeline + CodeBuild + per-service stages
├─ observability.tf  # AMP, Managed Grafana, synthetic probe, alarms, dashboards
└─ scripts/audit.sh  # naming + tag audit; "no devops-g1-* left" check for destroy
```

## Naming & tagging (enforced)
- `name_prefix = "devops-g1"` — every nameable resource.
- Every resource tagged via `provider.default_tags`:
  `group`, `owner`, `environment`, `service`, `managed-by=terraform`, `capstone=tillflow`.
- S3 bucket names get `-<account_id>` suffix (global uniqueness).
- Region: `us-east-1` only (ADR 0002).

## Usage (target)
```bash
cd infra/bootstrap && terraform init && terraform apply   # once
cd ..                && terraform init && terraform apply   # main stack (CI does the apply on main)
```

## G0 status
Scaffold only: `versions.tf`, `providers.tf`, `variables.tf`, `locals.tf`, `backend.tf`
and `bootstrap/` are stubbed so `terraform validate` runs. Real resources land in G1.

## Grafana access (G3)

The AMG workspace (`observability.tf`) authenticates through IAM Identity
Center. Terraform creates the workspace and its CloudWatch/X-Ray data sources,
but **not** user assignments: `aws_grafana_role_association` takes Identity
Center user IDs, which are per-person identifiers that do not belong in version
control.

Grant a person access with one call. `<user-id>` comes from Identity Center
(`aws identitystore list-users --identity-store-id d-90667d9391`):

```bash
aws grafana update-permissions \
  --workspace-id "$(cd infra && terraform output -raw grafana_workspace_id)" \
  --update-instruction-batch \
    'action=ADD,role=ADMIN,users=[{id=<user-id>,type=SSO_USER}]' \
  --region us-east-1
```

Use `role=ADMIN` for the Reliability DRI (Rigbe builds the dashboards) and
`role=VIEWER` for anyone who only needs to read them. Dashboards themselves are
Area 4's deliverable, not Platform's — see `docs/ownership.md`.

## Before a hand-run `terraform apply`

```bash
./infra/scripts/preflight.sh
```

Terraform **auto-loads** `infra/terraform.tfvars`. That file is gitignored and written by
`deploy.sh`, so it records whatever digest *your machine* last deployed. If a teammate has
deployed since, your copy is stale — and a bare `terraform apply` silently rewrites their
task definitions back to your older image, or to the busybox placeholder for any service
your copy records as `""`.

That is not hypothetical: it reverted `devops-g1-migrate-pos` to busybox during G4 drill
2.5, which is why that drill could not verify row counts (`docs/scar-log.md`).

The preflight compares the file against what is actually running and fails if an apply
would revert anything. It fails closed — if it cannot reach AWS it errors rather than
reporting a pass it cannot justify.

CI is unaffected: `deploy.yml` passes `-var 'service_images={}'` explicitly, which
overrides the file. This is a human-at-a-terminal problem, and the preflight is the guard.
