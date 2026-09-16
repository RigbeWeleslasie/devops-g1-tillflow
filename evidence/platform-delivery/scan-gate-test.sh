#!/usr/bin/env bash
#
# scan-gate-test.sh — replays the deploy.yml ECR scan gate against a fixture.
#
# Exit codes are deliberately NOT 0/1:
#   0 = gate PASSES the image (no fixable HIGH/CRITICAL)
#   2 = gate BLOCKS the image (fixable findings present)
#   1 = the harness itself failed (missing fixture, bad jq, unreadable JSON)
#
# A plain 0/1 cannot distinguish "the gate blocked" from "the script crashed",
# so a broken harness would report the block it was supposed to be proving.
# For a script whose only job is to be evidence, that is the one property it
# cannot lack.

set -uo pipefail

fixture="${1:?usage: scan-gate-test.sh <fixture.json>}"

if [[ ! -r "$fixture" ]]; then
  echo "harness: cannot read fixture: $fixture" >&2
  exit 1
fi

if ! raw="$(cat "$fixture")" || ! jq -e . >/dev/null 2>&1 <<<"$raw"; then
  echo "harness: fixture is not valid JSON: $fixture" >&2
  exit 1
fi

# --- the gate's own logic, verbatim from .github/workflows/deploy.yml ------
if jq -e '.imageScanFindings.enhancedFindings' >/dev/null 2>&1 <<<"$raw"; then
  fixable=$(jq '[
    .imageScanFindings.enhancedFindings[]
    | select(.severity == "HIGH" or .severity == "CRITICAL")
    | select(
        (.packageVulnerabilityDetails.vulnerablePackages // [])
        | map(.fixedInVersion // "")
        | any(. != "" and . != "NotAvailable")
      )
  ] | length' <<<"$raw") || { echo "harness: jq failed (enhanced)" >&2; exit 1; }
else
  fixable=$(jq '[
    .imageScanFindings.findings[]?
    | select(.severity == "HIGH" or .severity == "CRITICAL")
  ] | length' <<<"$raw") || { echo "harness: jq failed (basic)" >&2; exit 1; }
fi

if [[ ! "$fixable" =~ ^[0-9]+$ ]]; then
  echo "harness: fixable count is not a number: '$fixable'" >&2
  exit 1
fi

echo "fixable=$fixable"
[ "$fixable" -gt 0 ] && exit 2
exit 0
