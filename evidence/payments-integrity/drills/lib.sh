#!/usr/bin/env bash
# Shared plumbing for the G4 payments drills (2.1, 2.2). Sourced, not run.
#
# Every step stamps a UTC timestamp and appends the REAL response to the
# evidence file, so the record is what happened, not a description of it.
# docs/g4-plan.md §6: a drill counts only when executed against the real system
# and timed.
#
# Required:
#   BASE_URL        the public API Gateway edge, e.g. https://xxx.execute-api.us-east-1.amazonaws.com
#   SERVICE_TOKEN   payments' service token (Secrets Manager devops-g1/service-token)
# Optional:
#   PAYMENTS_PREFIX default /api/payments (the edge spelling; services strip it themselves)
#   EVIDENCE        output file; defaults per drill

set -euo pipefail

: "${BASE_URL:?BASE_URL is required (the API Gateway edge)}"
: "${SERVICE_TOKEN:?SERVICE_TOKEN is required}"
PAYMENTS_PREFIX="${PAYMENTS_PREFIX:-/api/payments}"
API="${BASE_URL%/}${PAYMENTS_PREFIX}"

# Daraja sandbox's well-known test values; the stub honours the same amounts.
TILL="${TILL:-174379}"
MSISDN="${MSISDN:-254708374149}"

now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ; }
uuid() { node -e 'process.stdout.write(require("crypto").randomUUID())'; }

# `step` writes a heading + timestamp; `record` appends a labelled block.
step()   { printf '\n### %s\n\n`%s`\n\n' "$1" "$(now)" | tee -a "$EVIDENCE"; }
record() { printf '**%s**\n\n```\n%s\n```\n\n' "$1" "$2" | tee -a "$EVIDENCE"; }
note()   { printf '%s\n\n' "$1" | tee -a "$EVIDENCE"; }
fail()   { printf '\n**DRILL FAILED:** %s\n' "$1" | tee -a "$EVIDENCE"; exit 1; }

# curl with the service token; prints "HTTP <code>\n<body>".
api() {
  local method="$1" path="$2"; shift 2
  curl -sS -m "${CURL_TIMEOUT:-45}" -X "$method" "${API}${path}" \
    -H "x-service-token: ${SERVICE_TOKEN}" -H "content-type: application/json" "$@" \
    -w '\nHTTP %{http_code}'
}
# Unauthenticated, for the callback endpoint — the caller is "Daraja".
api_public() {
  local method="$1" path="$2"; shift 2
  curl -sS -m 20 -X "$method" "${API}${path}" -H "content-type: application/json" "$@" -w '\nHTTP %{http_code}'
}
body_of() { sed '$d' <<<"$1"; }
code_of() { tail -1 <<<"$1" | sed 's/HTTP //'; }
jqf()     { jq -r "$1" <<<"$2"; }

start_evidence() {
  local title="$1"
  mkdir -p "$(dirname "$EVIDENCE")"
  {
    printf '# %s\n\n' "$title"
    printf -- '- **Executed:** %s\n- **Target:** `%s`\n- **Operator:** %s\n- **Commit:** `%s`\n\n' \
      "$(now)" "$API" "${OPERATOR:-$(git config user.name 2>/dev/null || echo unknown)}" \
      "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    printf 'Every block below is the real response, captured as it happened.\n'
  } > "$EVIDENCE"
  DRILL_T0=$(date +%s)
}

finish_evidence() {
  local elapsed=$(( $(date +%s) - DRILL_T0 ))
  printf '\n---\n\n**Drill wall-clock: %dm %02ds.** Result: %s\n' $((elapsed/60)) $((elapsed%60)) "$1" | tee -a "$EVIDENCE"
}
