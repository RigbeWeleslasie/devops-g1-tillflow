#!/usr/bin/env bash
# Runs the gate against every fixture and asserts the expected verdict.
set -uo pipefail
d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
declare -a cases=(
  "a-fixable:1:a fixable CRITICAL must BLOCK"
  "b-unfixable:0:fixedInVersion=NotAvailable must NOT block"
  "c-empty-string:0:fixedInVersion empty must NOT block"
  "d-clean:0:no findings must pass"
  "e-basic-scan:1:basic scan (no fixability data) must BLOCK"
)
fail=0
for c in "${cases[@]}"; do
  IFS=: read -r name want desc <<<"$c"
  "$d/scan-gate-test.sh" "$d/scan-gate-fixtures/$name.json" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then printf '  PASS  %s\n' "$desc"
  else printf '  FAIL  %s (exit %s, wanted %s)\n' "$desc" "$got" "$want"; fail=1; fi
done
exit $fail
