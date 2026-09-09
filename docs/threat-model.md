# Threat model — TillFlow / devops-g1

- **DRI:** Meron (Platform + delivery), with Nebyat (payment integrity threats)
- **Method:** STRIDE per trust boundary + payment-specific abuse cases
- **Date:** 2026-09-09 (living document — revisited at G3 and G4)

## 1. Assets

| Asset | Why it matters |
| ----- | -------------- |
| M-Pesa till + B2C ability | Direct money movement. Compromise = theft. |
| Daraja credentials (`devops-g1/daraja`) | Grant STK/B2C on the till. |
| Slack webhook (`devops-g1/slack-webhook`) | Alert channel; leak = spam / social engineering. |
| DB credentials (`devops-g1/db`) | All tenant + payment data. |
| Payout ledger integrity | Double-pay or mis-pay = financial loss + trust. |
| Tenant sales data (multi-tenant) | Cross-tenant leakage = privacy breach. |
| Terraform state | Contains resource metadata; write access = infra takeover. |
| CI OIDC role (`devops-g1-ci-deploy`) | Deploy anything to the account. |

## 2. Trust boundaries

```
Internet ──► API Gateway ──► VPC Link/ALB ──► ECS services ──► RDS / Redis / SQS / Secrets
   │                                              │
Daraja sandbox ◄───────────────────────────────── payments only
GitHub ──► Actions (OIDC) ──► AWS
GitHub ──► CodeConnections ──► CodePipeline ──► ECR/ECS
```

## 3. STRIDE by boundary

### 3.1 Internet → API Gateway

| Threat | Vector | Mitigation |
| ------ | ------ | ---------- |
| Spoofing | Forged auth token | Short-lived JWT; tenant derived from token, not body; API GW authorizer. |
| Tampering | Modified sale totals / amounts | Server recomputes totals; amount validated against sale; integer minor units. |
| Repudiation | "I never made that sale" | Append-only audit of sale + payment state transitions with `trace_id`. |
| Info disclosure | Cross-tenant IDOR | `tenant_id` from principal; mismatched resource → 404. Tested. |
| DoS | Flood STK Push (cost + Daraja rate limit) | API GW throttling + per-tenant rate limit + WAF rate rule; STK only from `UNPAID` sale. |
| Elevation | attendant acts as owner | Role checked per endpoint; owner-only routes for till/rate/role config. |

### 3.2 API Gateway → ALB / ECS

| Threat | Mitigation |
| ------ | ---------- |
| Direct-to-ALB bypass | ALB in private subnets only; SG allows the VPC Link SG only; no public IP. |
| Lateral movement between services | Per-service SGs; `pos` SG cannot reach `payments` DB port; service-to-service only over the ALB with mTLS/authz header (G2). |
| Container escape / tampering | Non-root, read-only root filesystem, dropped capabilities, pinned base image digest, image scan gate. |

### 3.3 Services → data / edges

| Threat | Mitigation |
| ------ | ---------- |
| Callback spoofing (fake "you were paid") | Validate callback source (Daraja IP allow-list where available) + match `CheckoutRequestID` to a charge we initiated + never trust amount from callback alone (cross-check `stkQuery`). |
| Callback replay → double effect | ADR 0006: dedupe table + guarded single transition + ledger effect in same txn. |
| Commission worker calls Daraja directly | Architecturally forbidden; `commission` has no Daraja creds, no egress SG to Safaricom; only the Payments API. Enforced + G2 gate check. |
| SQL injection | Parameterized queries / ORM; least-privilege per-schema role limits blast radius. |
| Cross-schema read | `pos-app` role has no grant on `payments` schema and vice versa. |
| Secret exposure in logs | Structured logging with an allow-list of fields; redact `Authorization`, `password`, `msisdn` (partial-mask phone numbers). Secret scanning in CI. |
| Cache poisoning | Cache-aside with short TTL; keys namespaced by `tenant_id`; write-through invalidation on config change. |

### 3.4 Supply chain / CI-CD

| Threat | Mitigation |
| ------ | ---------- |
| Malicious dependency | SBOM per build; dependency scan; fail on fixable HIGH/CRITICAL. |
| Compromised base image | Pin by digest; ECR enhanced scanning; rebuild weekly. |
| Poisoned pipeline (PR from fork) | `terraform apply` only on `main` via OIDC with a protected environment + required review; forked PRs get plan only, no secrets. |
| `latest` tag / mutable artifact | No `latest`; build by SHA, deploy by immutable digest; ECR tag immutability on. |
| OIDC role over-permission | `devops-g1-ci-deploy` trust policy scoped to this repo + `main`/PR refs; permissions scoped to the stack's resources. |
| Terraform state tampering | State bucket: versioning, KMS, block-public, bucket policy restricting to CI + platform roles; DynamoDB lock. |

## 4. Payment-specific abuse cases

| # | Abuse | Control |
| - | ----- | ------- |
| A1 | Replay a successful STK callback to credit a sale twice | Dedupe + guarded transition (I3). |
| A2 | Send a callback for a `CheckoutRequestID` we never issued | Reject: no matching initiated charge. |
| A3 | Race two `POST /charges` for one sale (timeout retry) | `UNIQUE(sale_id)` (I2). |
| A4 | Re-trigger the daily close to double-pay commissions | `UNIQUE(tenant,attendant,day)` + `ledger_id`-idempotent payout (I4). |
| A5 | Manipulate commission rate mid-close | Rate snapshot captured into the ledger row at compute time. |
| A6 | Force a timeout then claim non-payment | Stays `PENDING`; reconcile via `stkQuery`; never auto-fail (I5). |
| A7 | B2C to an attacker-controlled MSISDN | MSISDN comes from the attendant record (owner-managed), not from the request; change is audited. |
| A8 | Exfiltrate another tenant's sales | Row-level `tenant_id` scoping + per-schema DB role. |

## 5. Residual risks / accepted for capstone scope

| Risk | Rationale | Owner | Expiry |
| ---- | --------- | ----- | ------ |
| Secret rotation not automated | Sandbox creds, short-lived project | Meron | G5 |
| No WAF managed rule groups (cost) | API GW throttling deemed sufficient for capstone load | Meron | G5 |
| Single AWS account (no org SCPs) | Provided account | Meron | G5 |
| Daraja callback IP allow-list may be unavailable in sandbox | Compensate with `CheckoutRequestID` match + `stkQuery` cross-check | Nebyat | G5 |
