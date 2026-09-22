#!/usr/bin/env bash
# G4 drill 2.1 — uncertain payment / Daraja timeout. docs/runbook.md §2.1.
#
# Proof the runbook asks for: "force scenario ...03, show retry creates no
# second charge, show trace." Scenario 03 is KES 103: the deterministic timeout
# in ADR 0005's table, honoured by the stub over real HTTP (the stub holds the
# socket open past the adapter's timeout, so Payments experiences a genuine
# network timeout, not a simulated one).
#
# What this proves, in order:
#   I5  a timeout leaves the charge PENDING with no CheckoutRequestID — never
#       FAILED, because we do not know what happened.
#   I2  retrying the same sale returns the SAME charge and pushes nothing. The
#       customer is not prompted twice.
#   I5  the reconciler cannot query a charge with no reference; it counts the
#       look and leaves it for a late callback to adopt, or for a human. It
#       never auto-fails.
#
# Requires the deployed Payments to be pointed at the stub (DARAJA_BASE_URL),
# not at the Safaricom sandbox — a real Daraja cannot be told to time out.
#
#   BASE_URL=https://<api-gw> SERVICE_TOKEN=... ./evidence/payments-integrity/drills/2.1-uncertain-payment.sh

cd "$(dirname "$0")/../../.." || exit 1
EVIDENCE="${EVIDENCE:-evidence/payments-integrity/drills/g4-2.1-uncertain-payment-$(date -u +%Y%m%dT%H%M%SZ).md}"
# shellcheck source=lib.sh
source evidence/payments-integrity/drills/lib.sh

start_evidence "G4 drill 2.1 — uncertain payment (Daraja timeout)"

SALE_ID=$(uuid); TENANT_ID=$(uuid)
BODY=$(jq -nc --arg s "$SALE_ID" --arg t "$TENANT_ID" --arg till "$TILL" --arg m "$MSISDN" \
  '{saleId:$s, tenantId:$t, amountMinor:10300, tenantTill:$till, customerMsisdn:$m}')

# ---------------------------------------------------------------------------
step "1. Force the timeout: POST /charges for KES 103"
note "The adapter's own timeout has to elapse before this returns — that wait IS the drill."
T_PUSH=$(date +%s)
RES=$(api POST /charges -H "X-Fake-Scenario: timeout" -d "$BODY")
T_PUSH_MS=$(( $(date +%s) - T_PUSH ))
record "POST /charges (took ${T_PUSH_MS}s)" "$RES"
[[ "$(code_of "$RES")" == "201" ]] || fail "expected 201, got $(code_of "$RES")"
CHARGE_ID=$(jqf .chargeId "$(body_of "$RES")")
STATUS=$(jqf .status "$(body_of "$RES")")
REF=$(jqf .checkoutRequestId "$(body_of "$RES")")
[[ "$STATUS" == "PENDING" ]] || fail "I5 violated: status is $STATUS, not PENDING"
[[ "$REF" == "null" ]]       || fail "expected no CheckoutRequestID after a timeout, got $REF"
note "✅ **I5:** charge \`$CHARGE_ID\` is \`PENDING\` with no CheckoutRequestID. There is no code path from a timeout to FAILED."

# ---------------------------------------------------------------------------
step "2. Retry the same sale: POST /charges again with the same saleId"
RES=$(api POST /charges -H "X-Fake-Scenario: timeout" -d "$BODY")
record "POST /charges (retry)" "$RES"
[[ "$(code_of "$RES")" == "200" ]] || fail "expected 200 (existing), got $(code_of "$RES")"
[[ "$(jqf .chargeId "$(body_of "$RES")")" == "$CHARGE_ID" ]] || fail "I2 violated: a second charge was created"
[[ "$(jqf .created "$(body_of "$RES")")" == "false" ]]       || fail "I2 violated: created=true on a retry"
note "✅ **I2:** the retry returned the same charge, \`created: false\`. One push reached the provider, not two."
AUDIT=$(api GET "/admin/charges/$CHARGE_ID/audit")
record "GET /admin/charges/$CHARGE_ID/audit — stkAttempts must still be 1" "$AUDIT"
[[ "$(jqf .stkAttempts "$(body_of "$AUDIT")")" == "1" ]] || fail "I2 violated: stkAttempts = $(jqf .stkAttempts "$(body_of "$AUDIT")") after a retry (expected 1)"

# ---------------------------------------------------------------------------
step "3. Reconcile until the reconciler gives up — and STILL does not fail the charge"
note "A charge with no CheckoutRequestID is \`unqueryable\`: there is nothing to ask Daraja about. Each look is counted. Past \`RECONCILE_MAX_ATTEMPTS\` it surfaces for a human via \`/admin/pending\` — it is never auto-failed. Looping the reconciler until that happens (max ${MAX_RECONCILE:-15} passes):"
SURFACED=false
for i in $(seq 1 "${MAX_RECONCILE:-15}"); do
  RES=$(api POST /admin/reconcile -d '{}')
  [[ "$(code_of "$RES")" == "200" ]] || fail "reconcile returned $(code_of "$RES")"
  UNQ=$(jqf .unqueryable "$(body_of "$RES")")
  [[ "$UNQ" -ge 1 ]] || fail "pass $i: reconciler did not report the charge as unqueryable (got $UNQ)"
  PEND=$(api GET /admin/pending)
  if jq -e --arg id "$CHARGE_ID" '.charges[] | select(.chargeId == $id)' <<<"$(body_of "$PEND")" >/dev/null; then
    SURFACED=true
    record "pass $i: POST /admin/reconcile" "$RES"
    record "pass $i: GET /admin/pending — the charge has crossed the threshold and is surfaced for a human" "$PEND"
    break
  fi
done
$SURFACED || fail "charge never surfaced in /admin/pending after ${MAX_RECONCILE:-15} passes"
SITUATION=$(jq -r --arg id "$CHARGE_ID" '.charges[] | select(.chargeId == $id) | .situation' <<<"$(body_of "$PEND")")
note "Situation reported: **$SITUATION**"
FINAL=$(api GET "/charges/$CHARGE_ID")
record "GET /charges/$CHARGE_ID after the reconciler gave up" "$FINAL"
[[ "$(jqf .status "$(body_of "$FINAL")")" == "PENDING" ]] || fail "I5 violated: the reconciler changed the status to $(jqf .status "$(body_of "$FINAL")")"
note "✅ **I5, the hard half:** $i reconcile passes, the reconciler has given up asking, the charge is surfaced for a human — and it is STILL \`PENDING\`. Nothing guessed. That is the one unrecoverable mistake this service refuses to make."

# ---------------------------------------------------------------------------
step "4. Trace"
note "In X-Ray, filter on \`annotation.payments.charge_id = \"$CHARGE_ID\"\` — one \`POST /charges\` segment with the outbound Daraja subsegment ending in a timeout, one short \`POST /charges\` segment for the retry with NO Daraja subsegment, one \`POST /admin/reconcile\` segment. Paste the trace id here:"
note "trace_id: _____________________"

finish_evidence "PASS — I2 and I5 held against the target above"
