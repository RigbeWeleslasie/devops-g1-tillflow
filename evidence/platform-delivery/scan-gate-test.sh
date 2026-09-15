#!/usr/bin/env bash
# Replays the deploy.yml gate logic against a fixture, to prove it blocks.
set -euo pipefail
raw="$(cat "$1")"
if jq -e '.imageScanFindings.enhancedFindings' >/dev/null 2>&1 <<<"$raw"; then
  fixable=$(jq '[
    .imageScanFindings.enhancedFindings[]
    | select(.severity == "HIGH" or .severity == "CRITICAL")
    | select(
        (.packageVulnerabilityDetails.vulnerablePackages // [])
        | map(.fixedInVersion // "")
        | any(. != "" and . != "NotAvailable")
      )
  ] | length' <<<"$raw")
else
  fixable=$(jq '[.imageScanFindings.findings[]? | select(.severity=="HIGH" or .severity=="CRITICAL")] | length' <<<"$raw")
fi
echo "fixable=$fixable"
[ "$fixable" -gt 0 ] && exit 1 || exit 0
