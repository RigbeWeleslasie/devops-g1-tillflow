# SLOs & error budgets — TillFlow / devops-g1 (DRAFT for G0)

- **DRI:** Rigbe (Reliability + operations)
- **Status:** Draft. Targets may change only **before final benchmarking**, with written
  rationale recorded here.
- **Window:** rolling **28 days**.
- **Budget formula:** `budget = eligible_events × (1 − target)`.

## Exclusions (applied to every SLI)

Excluded from both numerator and denominator:
- Invalid requests (4xx from client error: bad schema, auth failure, validation 422).
- Genuine business declines (customer cancelled STK, insufficient funds) — these are
  *correct* outcomes.

**Not excluded:** dependency outages (RDS, Redis, Daraja, SQS) when the user journey
fails. If a customer can't complete a sale because our cache is down, that burns budget.

## SLI catalogue

### Web — API shell / page loads

| Field | Value |
| ----- | ----- |
| User outcome | The attendant can open the app and it responds. |
| Numerator | Eligible `web` responses that are 2xx/3xx **and** served in < 500 ms (p95 gate tracked separately). |
| Denominator | All eligible `web` requests (excl. client 4xx). |
| Target | **≥ 99.9%** success; **p95 < 500 ms**. |
| 28-day budget | 0.1% → **~40m 19s** of downtime-equivalent. |
| Data source | ALB / API GW metrics + OTLP server span `http.server.duration`. |

### POS API — valid sale writes accepted exactly once

| Field | Value |
| ----- | ----- |
| User outcome | A recorded sale is saved once and only once. |
| Numerator | Valid `POST /sales` (and `/sales/{id}` mutations) that return the correct success response **and** result in exactly one row (idempotent replay returning the first response = success). |
| Denominator | All valid sale-write attempts (excl. 4xx validation/auth). |
| Target | **≥ 99.9%**; **p95 < 400 ms**. |
| 28-day budget | 0.1% → **~40m 19s**. |
| Data source | POS app metrics: `pos_sale_write_total{result=...}`, duplicate-detection counter, DB unique-violation counter. |

### Payments API — STK/B2C accepted & callbacks processed within 60s

| Field | Value |
| ----- | ----- |
| User outcome | A payment command is accepted and reaches a terminal, correct state within 60s of the provider callback. |
| Numerator | Valid STK/B2C commands accepted (ack received or correctly kept PENDING on timeout) **and** callbacks that drive a legal terminal transition within 60s of receipt. |
| Denominator | All valid STK/B2C commands + all received callbacks (excl. business declines, excl. malformed/spoofed callbacks). |
| Target | **≥ 99.5%**. |
| 28-day budget | 0.5% → **~3h 21m 36s**. |
| Notes | A **timeout that is correctly held PENDING and later reconciled** counts as success, not error. A timeout that we wrongly mark FAILED is an error **and** an incident. |
| Data source | `payments_command_total{type,result}`, `payments_callback_process_seconds` histogram, reconciliation outcome counter. |

### Commission — eligible payouts terminal by 06:30 EAT, zero double-pay

| Field | Value |
| ----- | ----- |
| User outcome | Every attendant is paid the right commission once, by 06:30 EAT. |
| Numerator | Eligible payout ledger rows that reach a terminal state (`PAID`/`FAILED`-with-reason) by 06:30 EAT. |
| Denominator | All eligible payout ledger rows for the business day. |
| Hard invariant | **Duplicate disbursement = 0** (not a percentage — any duplicate is a P1 incident and a gate failure). |
| Target | **≥ 99.0%** on time. |
| 28-day budget | 1% of events / **~0.28 late runs** (i.e. less than one late daily run per 28 days). |
| Data source | `commission_payout_total{state}`, `commission_run_duration_seconds`, ledger uniqueness check, `commission_run_completed_before_0630` gauge. |

## Burn-rate / budget policy

Multi-window burn-rate alerting (Google SRE style) on each SLO:

| Alert | Condition | Action |
| ----- | --------- | ------ |
| **Fast burn (page)** | Burn rate ≥ **14.4×** over 1h **and** ≥ 14.4× over 5m (≈ 2% of 28-day budget in 1h) | Page the area DRI. Start incident. Consider feature-flag / rollback. |
| **Slow burn (ticket)** | Burn rate ≥ **6×** over 6h **and** ≥ 6× over 30m (≈ 5% of budget in 6h) | Slack ticket to DRI. Investigate same day. |
| **Budget < 25% remaining** | 28-day budget consumed > 75% | **Release freeze** for that service: only reliability fixes and rollbacks merge. Notify group. |
| **Budget exhausted** | Budget ≤ 0 | Freeze + mandatory reliability review before any feature work resumes. Post-incident review written to `scar-log.md`. |
| **Budget recovered > 50%** | Rolling window recovers above 50% | Lift freeze; resume feature work. Announce in Slack. |

Commission's zero-double-pay invariant is **not** subject to burn-rate math: any breach is
an immediate P1, release freeze on `commission` + `payments`, and a scar-log entry.

## Capacity / k6 (target for G3)

- Load model, task size/count, scaling metric and highest sustainable RPS to be produced
  from k6 smoke → stepped baseline → spike → ≥15-min soak against the deterministic
  M-Pesa stub. Thresholds: failed < 1%, p95 < 500 ms, checks > 99%, CPU < 70%,
  mem < 75%, bounded queue age. See `k6/README.md`.

## Change log

| Date | Change | Rationale | By |
| ---- | ------ | --------- | -- |
| 2026-09-09 | Initial draft from the reliability contract | G0 | Rigbe |
