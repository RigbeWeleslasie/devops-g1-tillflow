# ADR 0003 — Database: RDS PostgreSQL

- **Status:** Accepted
- **Date:** 2026-09-09
- **DRI:** Meron (Platform + delivery)
- **Required proof:** this ADR + `terraform plan` for the `aws_db_instance` / parameter
  group / roles

## Context

The brief fixes the engine family (RDS PostgreSQL) and asks us to decide and defend:
engine version, instance class, storage size/type, Multi-AZ vs single-AZ, per-service
schemas + least-privilege roles, connection pooling, and automated backup window +
retention tied to an RPO.

Workload: low absolute volume (a capstone), but strict correctness — payment/payout state
machines, idempotency keys, unique ledger constraints. Read-mostly for tenant config
(cached in Redis). Write hotspots: sales, charges, callbacks, payout ledger.

## Decision

| Parameter            | Choice                                    | Why |
| -------------------- | ----------------------------------------- | --- |
| Engine version       | PostgreSQL **16.x** (latest minor at apply)| Current major; `MERGE`, better partitioning, long support window. |
| Instance class       | **db.t4g.small** (Graviton, 2 vCPU / 2 GiB)| Burstable is right for capstone load; cheapest Multi-AZ-capable class. Revisit after k6 (G3). |
| Storage              | **gp3, 20 GiB**, autoscaling max 100 GiB   | gp3 gives baseline 3000 IOPS / 125 MB/s decoupled from size; no need to over-provision. |
| Multi-AZ             | **Yes (Multi-AZ instance)**                | Required to demonstrate an RPO ≈ 0 / low RTO story and to survive an AZ failure drill (G4). Synchronous standby. |
| Schemas              | One schema per owning service: `pos`, `payments`. `commission` uses the `payments` schema (payout ledger is a Payments-integrity concern). | Enforces service data boundaries. |
| Roles                | `devops-g1-pos-app`, `devops-g1-payments-app` — each `GRANT`ed only on its own schema; no superuser; no cross-schema `SELECT`. Migration role separate from runtime role. | Least privilege; a compromised service can't read another's data. |
| Connection pooling   | **RDS Proxy** in front of the instance; apps use small per-task pools (max 5). | Fargate task churn + burstable instance = must not exhaust `max_connections`. |
| Backup window        | Automated backups **02:00–03:00 UTC** (05:00–06:00 EAT, after the daily close and B2C settle). | Avoids the 00:15 EAT close and the 06:30 EAT payout SLO deadline. |
| Backup retention     | **7 days** automated + one manual pre-G4 snapshot. | |
| RPO / RTO            | **RPO ≤ 5 min** (automated backups + 5-min transaction logs; Multi-AZ sync standby ⇒ ~0 for AZ failure). **RTO ≤ 30 min** for a full restore-to-new-instance drill. | Stated in `runbook.md` and proven in G4. |
| Encryption           | Storage encrypted with a customer-managed KMS key. TLS required (`rds.force_ssl=1`). | |
| Deletion protection  | On for `prod`; disabled only in the destroy/rebuild runbook step. | |

## Consequences

- Terraform creates: `aws_db_instance` (Multi-AZ), `aws_db_parameter_group`
  (`force_ssl`, `log_min_duration_statement`), `aws_db_subnet_group` (2 private AZs),
  `aws_rds_proxy`, KMS key, and SQL bootstrap (schemas + roles) run as a migration job.
- Credentials live in Secrets Manager `devops-g1/db` with rotation left as a documented
  future item (capstone scope).
- `db.t4g.small` CPU-credit balance becomes a saturation signal on the Grafana dashboard;
  k6 soak must keep CPU < 70%. If the soak can't hit target RPS within budget, the
  superseding ADR bumps to `db.m7g.large` (documented before final benchmarking).
- Single instance + standby (no read replica) — acceptable because reads are cached and
  volume is low.
