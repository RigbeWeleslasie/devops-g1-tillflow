# TillFlow — devops-g1

Production-grade multi-tenant SaaS POS with M-Pesa payments on AWS ECS Fargate.
One private group mono-repo. All infrastructure is managed by Terraform. Delivery is
through GitHub Actions (PR checks + gated apply) and AWS CodePipeline (build → scan →
ECR → ECS → post-deploy smoke/rollback).

> **Daraja 3.0 sandbox only.** CI and k6 use a deterministic fake M-Pesa adapter.
> Never commit credentials or real customer data.

---

## Mission

Record sales, receive payment through an M-Pesa till (STK Push), and pay each register
attendant's daily commission through M-Pesa B2C. The system must stay **correct and
explainable** when requests time out, callbacks repeat, and infrastructure fails.

- **A timeout is not a decline.**
- **Replay must never double-pay.**

## Ownership matrix

| Primary area              | DRI    | Cross-reviews          |
| ------------------------- | ------ | ---------------------- |
| Product + POS             | Rigbe  | Payments + integrity   |
| Payments + integrity      | Nebyat | Platform + delivery    |
| Platform + delivery       | Meron  | Product + POS          |
| Reliability + operations  | Rigbe  | Payments + integrity   |

Full detail, decisions and personal proof obligations: [`docs/ownership.md`](docs/ownership.md).
Path → DRI mapping: [`CODEOWNERS`](CODEOWNERS).

## Architecture (summary)

```
WEB ──▶ API GATEWAY ──▶ SERVICES ─────────────▶ STATE + EDGES
(ECS Fargate)  (VPC Link + ALB)   POS │ Payments │ Commission   RDS │ Redis │ S3 │ SQS │ Daraja
```

Every backend task runs **two containers**: the application + an **ADOT Collector sidecar**
(OTLP → CloudWatch / Prometheus, X-Ray → Grafana). Full detail:
[`docs/architecture.md`](docs/architecture.md).

## Repo layout

```
services/         web · pos · payments · commission · _shared
infra/            Terraform: AWS resources, pipelines, alarms, dashboards
.github/workflows/ GitHub Actions: PR checks + gated apply
k6/               load model + scenarios (smoke / baseline / spike / soak)
docs/             ownership, architecture, ADRs, SLOs, runbook, threat model, scar log
evidence/         per-area runtime proof + exact reproduction commands
CODEOWNERS        maps each path to its DRI
```

## Region & naming

- **AWS Region:** `us-east-1` — justified in [`docs/adr/0002-aws-region.md`](docs/adr/0002-aws-region.md).
- **Name prefix:** `devops-g1-` (lowercase, hyphenated) on every nameable resource.
- **Required tags on every resource:** `group`, `owner`, `environment`, `service`,
  `managed-by=terraform`, `capstone=tillflow`.
- S3 bucket names get an account-id suffix for global uniqueness
  (e.g. `devops-g1-tfstate-<ACCOUNT_ID>`).

## One-command lifecycle (target — wired during G1)

```bash
make bootstrap     # create tfstate bucket + lock table (one-time)
make deploy        # terraform apply + trigger pipeline
make smoke         # post-deploy smoke tests
make destroy       # tear everything down
```

## Delivery gates

| Gate            | Due | What it proves                                                       |
| --------------- | --- | ------------------------------------------------------------------- |
| G0 — Decide     | D2  | Repo, ownership matrix, architecture, ADRs, threat model, draft SLOs |
| G1 — Platform   | D5  | Terraform plan/apply, naming/tag audit, ECS golden path, first deploy |
| G2 — Product    | D8  | Sale → STK callback → paid; close → commission → B2C; idempotency    |
| G3 — Operate    | D11 | Grafana SLO/budget panels, traces, k6 envelope, Slack alerts         |
| G4 — Recover    | D13 | Failure drills, DLQ recovery, rollback, restore, runbook rehearsal   |
| G5 — Release    | D14 | Fresh-commit release, evidence pack, individual defences, destroy/rebuild |

**Due: Mon 21 Sep 2026, 23:59 EAT.**

## Status

G0 in progress — see [`docs/`](docs/) and open PR `g0-decide`.
