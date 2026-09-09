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
