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
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

# `commission` is a worker: no target group, no listener rule (edge.tf). A
# /commission/* request would fall through to the web_default rule and read
# WEB's /version -- passing for the wrong reason and hiding a broken deploy.
# Verify it through ECS instead.
if [[ "$SERVICE" == "commission" ]]; then
  echo "commission is a worker (no ingress) — verifying via ECS, not HTTP"

  read -r desired running <<<"$(aws ecs describe-services \
    --cluster "${CLUSTER:-$PREFIX}" --services "${PREFIX}-${SERVICE}" \
    --query 'services[0].[desiredCount,runningCount]' --output text)"

  # desiredCount 0 is a legitimate state at G1 -- commission has no workload yet
  # -- so this is a SKIP, loudly, not a pass and not a failure.
  #
  # `running == desired` alone would silently pass at 0 == 0 (a smoke test that
  # cannot fail on an empty service is not a gate). Hard-failing instead is just
  # as wrong: any push touching services/_shared/ fans the matrix to all four
  # services, and commission would then roll back a perfectly good deploy.
  if [[ "$desired" == "0" ]]; then
    dim "SKIP  ${SERVICE}: desiredCount=0 — not scaled up yet, nothing to smoke."
    dim "      This is expected until the service has its own workload (G2)."
    exit 0
  fi

  if [[ "$running" != "$desired" ]]; then
    red "FAIL  ${SERVICE}: running=$running desired=$desired"
    exit 1
  fi

  if [[ -n "$EXPECTED_SHA" ]]; then
    # The deployed artifact must be the commit we built. The image is deployed
    # by digest, so compare against the digest that SHA tag resolves to.
    want="$(aws ecr describe-images --repository-name "${PREFIX}/${SERVICE}" \
      --image-ids "imageTag=${EXPECTED_SHA}" \
      --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || echo '')"
    got="$(aws ecs describe-task-definition \
      --task-definition "${PREFIX}-${SERVICE}" \
      --query "taskDefinition.containerDefinitions[?name=='${SERVICE}'].image | [0]" \
      --output text)"

    if [[ -z "$want" || "$got" != *"$want"* ]]; then
      red "FAIL  ${SERVICE}: task definition image '$got' is not digest '$want'"
      exit 1
    fi
    green "PASS  ${SERVICE}: running=$running, image pinned to ${EXPECTED_SHA:0:12}"
  else
    green "PASS  ${SERVICE}: running=$running/$desired"
  fi

  green "SMOKE PASSED — $SERVICE"
  exit 0
fi

api="$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${PREFIX}'].ApiEndpoint | [0]" --output text)"

if [[ -z "$api" || "$api" == "None" ]]; then
  red "no API Gateway named '${PREFIX}' found"
  exit 1
fi

# The app strips this prefix itself (services/_shared/docker/app.js): API
# Gateway's ANY /{proxy+} and the ALB listener rules both forward the raw path.
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
