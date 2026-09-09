# ADR 0002 — AWS region: us-east-1

- **Status:** Accepted
- **Date:** 2026-09-09
- **DRI:** Meron (Platform + delivery)
- **Required proof:** this ADR + `terraform plan` showing `provider "aws" { region = "us-east-1" }`

## Context

The brief requires us to deploy in exactly one assigned AWS Region and to justify it in
an ADR. Console changes and multi-region sprawl earn no credit. Candidate regions:

| Region        | Latency to Daraja/EAT users | Service availability | Cost   | Notes |
| ------------- | --------------------------- | -------------------- | ------ | ----- |
| `af-south-1`  | Lowest                      | Partial (opt-in, some services/instance types missing; ADOT/AMP/Managed Grafana gaps) | Higher | Closest to users |
| `eu-west-1`   | Moderate (~150 ms)          | Full                 | Low    | Mature |
| `us-east-1`   | Higher (~230 ms)            | Full, first to get new features | Lowest | Default region |

Daraja itself is a sandbox HTTP API reachable from anywhere; payment correctness depends
on **timeout handling and reconciliation**, not on shaving tens of milliseconds of RTT.
CI, k6 and all failure drills run against a deterministic in-VPC fake adapter, so
customer-facing latency is not on the graded critical path for this capstone.

## Decision

Deploy the entire stack in **`us-east-1`** (N. Virginia).

Rationale:
1. **Full service coverage** — API Gateway HTTP API + VPC Link, ECS Fargate, RDS
   Multi-AZ, ElastiCache, ADOT, Amazon Managed Prometheus, Amazon Managed Grafana, X-Ray,
   EventBridge Scheduler, CodePipeline/CodeConnections are all GA with no opt-in friction.
   `af-south-1` has known gaps (e.g. Managed Grafana, some Fargate/RDS options) that would
   cost us gate time.
2. **Lowest cost** — matters for a short-lived capstone account with a destroy/rebuild
   requirement.
3. **Reproducibility** — every AWS tutorial, quickstart and Terraform module defaults to
   `us-east-1`; fewer "not available in this region" surprises during G1–G5.
4. Latency to end users is acceptable for a POS whose correctness model is
   timeout-tolerant; the synthetic probe and SLO p95 targets are set with this in mind.

## Consequences

- `variable "aws_region"` defaults to `us-east-1`; documented, not overridable per-env.
- S3 (`tfstate`, `artifacts`, `logs`, `backups`, `evidence`) and the DynamoDB lock table
  live in `us-east-1`.
- If a future benchmarking pass shows latency dominates the Payments SLO, revisit with a
  superseding ADR before final benchmarking (targets may only change before then, with
  written rationale).
- Disaster-recovery restore target (G4) is a separate stack **in the same region**.
