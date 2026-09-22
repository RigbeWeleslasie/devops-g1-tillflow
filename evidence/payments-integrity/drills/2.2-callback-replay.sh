#!/usr/bin/env bash
# G4 drill 2.2 — callback replay / reorder. docs/runbook.md §2.2.
#
# Proof the runbook asks for: "replay + reorder callbacks, show one legal
# transition, one ledger effect, one explanatory trace."
#
#   Replay   KES 104 is ADR 0005's `duplicate_callback` scenario: the stub
#            delivers the SAME success callback twice, over the network, to
#            the public edge. I3: one transition, one outbox row, and the
#            second delivery lands on the same callback_events row as a bump
#            to duplicate_count — "second span, zero writes".
#   Reorder  a callback arriving AFTER the charge is already terminal — the
#            out-of-order case. Injected by hand for a charge that is already
#            PAID: recorded, matched, applied=false, nothing changes.
#
# Requires the deployed Payments pointed at the stub, and the stub able to
# reach MPESA_CALLBACK_BASE_URL — which is the public edge, so the callbacks
# traverse API Gateway -> ALB -> Payments exactly as Daraja's would.
#
#   BASE_URL=https://<api-gw> SERVICE_TOKEN=... ./evidence/payments-integrity/drills/2.2-callback-replay.sh

cd "$(dirname "$0")/../../.." || exit 1
EVIDENCE="${EVIDENCE:-evidence/payments-integrity/drills/g4-2.2-callback-replay-$(date -u +%Y%m%dT%H%M%SZ).md}"
# shellcheck source=lib.sh
source evidence/payments-integrity/drills/lib.sh

start_evidence "G4 drill 2.2 — callback replay / reorder"

SALE_ID=$(uuid); TENANT_ID=$(uuid)
BODY=$(jq -nc --arg s "$SALE_ID" --arg t "$TENANT_ID" --arg till "$TILL" --arg m "$MSISDN" \
  '{saleId:$s, tenantId:$t, amountMinor:10400, tenantTill:$till, customerMsisdn:$m}')

# ---------------------------------------------------------------------------
step "1. Create a charge the stub will call back TWICE about: POST /charges for KES 104"
RES=$(api POST /charges -H "X-Fake-Scenario: duplicate_callback" -d "$BODY")
record "POST /charges" "$RES"
[[ "$(code_of "$RES")" == "201" ]] || fail "expected 201, got $(code_of "$RES")"
CHARGE_ID=$(jqf .chargeId "$(body_of "$RES")")
REF=$(jqf .checkoutRequestId "$(body_of "$RES")")
[[ "$REF" != "null" ]] || fail "expected a CheckoutRequestID; did the push reach the stub?"

# ---------------------------------------------------------------------------
step "2. Wait for both deliveries, then read the charge back"
note "The stub delivers on a timer; both copies traverse the public edge. Polling until PAID (max 60s)."
T_CB=$(date +%s)
for _ in $(seq 1 30); do
  RES=$(api GET "/charges/$CHARGE_ID")
  [[ "$(jqf .status "$(body_of "$RES")")" == "PAID" ]] && break
  sleep 2
done
record "GET /charges/$CHARGE_ID (PAID after $(( $(date +%s) - T_CB ))s)" "$RES"
[[ "$(jqf .status "$(body_of "$RES")")" == "PAID" ]] || fail "charge never reached PAID — did the callbacks reach the edge?"
note "✅ One legal transition: \`PENDING -> PAID\`, once. The confirming stkQuery (G5) agreed before it was applied."

# The second delivery lands shortly after the first; wait for it to be counted.
note "Waiting for the redelivery to be recorded (\`duplicateCount = 1\` on the one row)..."
for _ in $(seq 1 15); do
  AUDIT=$(api GET "/admin/charges/$CHARGE_ID/audit")
  [[ "$(jqf '.callbackEvents[0].duplicateCount // 0' "$(body_of "$AUDIT")")" -ge 1 ]] && break
  sleep 2
done
record "GET /admin/charges/$CHARGE_ID/audit — every callback received, every ledger effect produced" "$AUDIT"
A=$(body_of "$AUDIT")
[[ "$(jqf '.callbackEvents | length' "$A")" == "1" ]]                      || fail "I3 violated: $(jqf '.callbackEvents | length' "$A") callback rows for two identical deliveries (expected 1)"
[[ "$(jqf '.callbackEvents[0].duplicateCount' "$A")" -ge 1 ]]              || fail "the redelivery was never recorded as a duplicate"
[[ "$(jqf '.callbackEvents[0].applied' "$A")" == "true" ]]                 || fail "the callback was never applied"
[[ "$(jqf '.outboxEvents | length' "$A")" == "1" ]]                        || fail "I3 violated: $(jqf '.outboxEvents | length' "$A") ledger effects (expected exactly 1)"
[[ "$(jqf '.outboxEvents[0].eventType' "$A")" == "sale.paid" ]]            || fail "unexpected outbox event type"
note "✅ **I3 (replay):** two deliveries over the network, ONE \`callback_events\` row with \`duplicateCount = $(jqf '.callbackEvents[0].duplicateCount' "$A")\`, ONE \`sale.paid\`. The second delivery wrote nothing — \"second span, zero writes\"."

# ---------------------------------------------------------------------------
step "3. Reorder: inject a callback that arrives AFTER the charge is terminal"
LATE=$(jq -nc --arg r "$REF" --arg m "$MSISDN" '{Body:{stkCallback:{MerchantRequestID:"late",CheckoutRequestID:$r,ResultCode:0,ResultDesc:"The service request is processed successfully.",CallbackMetadata:{Item:[{Name:"Amount",Value:104},{Name:"MpesaReceiptNumber",Value:"LATE0001"},{Name:"TransactionDate",Value:20260922120000},{Name:"PhoneNumber",Value:($m|tonumber)}]}}}}')
RES=$(api_public POST /callbacks/stk -d "$LATE")
record "POST /callbacks/stk (a success callback for an already-PAID charge)" "$RES"
[[ "$(code_of "$RES")" == "200" ]] || fail "Daraja must always get its ack; got $(code_of "$RES")"
AUDIT=$(api GET "/admin/charges/$CHARGE_ID/audit")
record "GET /admin/charges/$CHARGE_ID/audit after the late callback" "$AUDIT"
A=$(body_of "$AUDIT")
[[ "$(jqf .status "$A")" == "PAID" ]]                                                        || fail "a late callback changed a terminal charge"
[[ "$(jqf '.callbackEvents | length' "$A")" == "2" ]]                                        || fail "the late callback (different bytes) should be its own row; got $(jqf '.callbackEvents | length' "$A")"
[[ "$(jqf '[.callbackEvents[] | select(.applied)] | length' "$A")" == "1" ]]                 || fail "I3 violated: applied $(jqf '[.callbackEvents[] | select(.applied)] | length' "$A") times (expected exactly 1)"
[[ "$(jqf '.outboxEvents | length' "$A")" == "1" ]]                                          || fail "I3 violated: the late callback produced a ledger effect"
note "✅ **I3 (reorder):** the out-of-order callback was acked, recorded as its own row with \`applied: false\`, and produced no ledger effect. Still one transition, still one \`sale.paid\`. First resolution wins."

# ---------------------------------------------------------------------------
step "4. Trace"
note "In X-Ray, filter on \`annotation.mpesa.checkout_request_id = \"$REF\"\` — three \`POST /callbacks/stk\` segments: the first with a Daraja stkQuery subsegment and a DB write, the second and third short with no state writes. Paste the trace id here:"
note "trace_id: _____________________"

finish_evidence "PASS — I3 held against the deployed stack: one transition, one ledger effect, at any order or repetition"
