#!/usr/bin/env bash
#
# smoke.sh — post-deploy verification.
#
# DRI: Meron (Platform + delivery).
#
#   ./infra/scripts/smoke.sh pos [expected-sha]
#
# Checks /health, /ready and /version through the public API Gateway edge. When
# an expected SHA is given, asserts the RUNNING code is that commit -- which is
# what makes this a release gate rather than a liveness poll. A deploy that
# "succeeded" but left the old image running fails here.

set -euo pipefail

SERVICE="${1:?usage: smoke.sh <service> [expected-sha]}"
EXPECTED_SHA="${2:-}"
PREFIX="${NAME_PREFIX:-devops-g1}"
ATTEMPTS="${ATTEMPTS:-12}"
SLEEP="${SLEEP:-10}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

api="$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${PREFIX}'].ApiEndpoint | [0]" --output text)"

if [[ -z "$api" || "$api" == "None" ]]; then
  red "no API Gateway named '${PREFIX}' found"
  exit 1
fi

base="${api}/${SERVICE}"
echo "smoking $base"
echo

fail=0

check() {
  local path="$1" jq_expr="$2" label="$3"
  local body ok=false

  for _ in $(seq 1 "$ATTEMPTS"); do
    body="$(curl -fsS --max-time 10 "${base}${path}" 2>/dev/null || echo '')"
    if [[ -n "$body" ]] && jq -e "$jq_expr" <<<"$body" >/dev/null 2>&1; then
      ok=true
      break
    fi
    sleep "$SLEEP"
  done

  if $ok; then
    green "PASS  ${path}  $(jq -c . <<<"$body")"
  else
    red   "FAIL  ${path}  ${body:-<no response>}"
    fail=$((fail + 1))
  fi
}

check /health '.status == "ok"'    "health"
check /ready  '.status == "ready"' "ready"

if [[ -n "$EXPECTED_SHA" ]]; then
  # The important one: prove the deployed artifact is the commit we built.
  check /version ".sha == \"${EXPECTED_SHA}\"" "version"
else
  check /version '.sha != null and .sha != "unknown"' "version"
fi

echo
if ((fail == 0)); then
  green "SMOKE PASSED — $SERVICE"
  exit 0
fi
red "SMOKE FAILED — $fail check(s)"
exit 1
