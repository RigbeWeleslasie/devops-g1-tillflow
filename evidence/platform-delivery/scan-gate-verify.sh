#!/usr/bin/env bash
#
# scan-gate-verify.sh — proves the ECR scan gate blocks what it should.
#
# The gate was corrected three times in review (JSON path, a `// 0` default,
# then Inspector's literal "NotAvailable"). Each fix was reasonable in isolation,
# which is why "reviewed again" stopped being useful evidence.
#
# Every case asserts BOTH the verdict and the count behind it. Checking only the
# exit status would let a crashing harness (exit 1) masquerade as a block, so
# scan-gate-test.sh uses 2=blocked / 0=passed / 1=harness error, and the
# expected `fixable=` count is asserted as well.

set -uo pipefail

d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test="$d/scan-gate-test.sh"
fixtures="$d/scan-gate-fixtures"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

# fixture : expected exit (0=pass, 2=blocked) : expected count : description
cases=(
  "a-fixable:2:1:a fixable CRITICAL must BLOCK"
  "b-unfixable:0:0:fixedInVersion=NotAvailable must NOT block"
  "c-empty-string:0:0:fixedInVersion empty must NOT block"
  "d-clean:0:0:no findings must pass"
  "e-basic-scan:2:1:basic scan (no fixability data) must BLOCK"
  "f-mixed:2:1:a fixable finding alongside an unfixable one must BLOCK"
)

fail=0
for c in "${cases[@]}"; do
  IFS=: read -r name want_exit want_count desc <<<"$c"

  out="$("$test" "$fixtures/$name.json" 2>&1)"
  got_exit=$?
  got_count="$(sed -n 's/^fixable=\([0-9]*\)$/\1/p' <<<"$out")"

  if [[ "$got_exit" == 1 ]]; then
    red "  ERROR $desc"
    red "        harness failed: $out"
    fail=1
    continue
  fi

  if [[ "$got_exit" != "$want_exit" || "$got_count" != "$want_count" ]]; then
    red "  FAIL  $desc"
    red "        exit=$got_exit (want $want_exit), fixable=${got_count:-<none>} (want $want_count)"
    fail=1
    continue
  fi

  green "  PASS  $desc"
done

# The harness must also fail loudly on its own breakage, or the checks above
# prove nothing. A missing fixture is the cheapest way to exercise that.
if "$test" "$fixtures/does-not-exist.json" >/dev/null 2>&1; then
  red "  FAIL  harness self-check: a missing fixture should exit 1"
  fail=1
else
  [[ $? == 1 ]] && green "  PASS  harness self-check: a missing fixture exits 1, not a verdict"
fi

echo
if ((fail == 0)); then
  green "SCAN GATE VERIFIED"
  exit 0
fi
red "SCAN GATE VERIFICATION FAILED"
exit 1
