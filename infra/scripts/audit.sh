#!/usr/bin/env bash
#
# audit.sh — naming + tag audit for the G1 gate, and the cleanup check for G5.
#
# G1 requires a "naming + tag audit"; the gate is blocked on "broken naming/tags".
# This script is the check, and its output is the evidence.
#
# Every taggable resource we create must:
#   1. be named with the devops-g1 prefix (or /devops-g1/ for log groups), and
#   2. carry all six required tags: group, owner, environment, service,
#      managed-by=terraform, capstone=tillflow.
#
# Usage:
#   ./infra/scripts/audit.sh              # audit (exit 1 on any violation)
#   ./infra/scripts/audit.sh --cleanup    # assert nothing is left (post-destroy, G5)
#
# Requires: awscli v2, jq. Honours AWS_PROFILE / AWS_REGION.

set -euo pipefail

PREFIX="${NAME_PREFIX:-devops-g1}"
REGION="${AWS_REGION:-us-east-1}"
MODE="${1:-audit}"

# Single source of truth for the capstone account: the `aws_account_id` default
# in infra/variables.tf, which is also what the provider pins via
# allowed_account_ids. Overridable with EXPECTED_ACCOUNT for a fork or a rotation.
_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_tf_vars="$_script_dir/../variables.tf"
EXPECTED_ACCOUNT="${EXPECTED_ACCOUNT:-$(
  awk '/variable "aws_account_id"/,/^}/' "$_tf_vars" 2>/dev/null |
    sed -n 's/.*default[[:space:]]*=[[:space:]]*"\([0-9]\{12\}\)".*/\1/p' | head -1
)}"

if [[ ! "$EXPECTED_ACCOUNT" =~ ^[0-9]{12}$ ]]; then
  printf '\033[31m%s\033[0m\n' "Could not read aws_account_id from $_tf_vars; set EXPECTED_ACCOUNT."
  exit 2
fi

REQUIRED_TAGS=(group owner environment service managed-by capstone)

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

violations=0
checked=0

# --- guard: never audit (or report on) the wrong account -------------------
account="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$account" != "$EXPECTED_ACCOUNT" ]]; then
  red "Refusing to run: connected to account $account, expected $EXPECTED_ACCOUNT."
  red "Check AWS_PROFILE (the workstation 'default' profile is a different account)."
  exit 2
fi

echo "Account : $account"
echo "Region  : $REGION"
echo "Prefix  : $PREFIX"
echo

# ---------------------------------------------------------------------------
# Tag audit — via the Resource Groups Tagging API, which sees every taggable
# resource at once rather than per-service describe calls.
# ---------------------------------------------------------------------------

echo "== Tag audit =="

# Fetch EVERY tagged resource in the region, not just ones already carrying
# capstone=tillflow.
#
# Filtering on the tag first makes the audit unable to fail on its own subject: a
# resource missing `capstone` is simply not returned, so a missing required tag
# is invisible to the check that exists to catch it. Instead, pull everything and
# select ours by the name prefix as well as the tag -- a devops-g1-* resource
# that is missing tags then still shows up, and still fails.
all_json="$(aws resourcegroupstaggingapi get-resources \
  --region "$REGION" --output json)"

resources_json="$(jq --arg p "$PREFIX" '
  .ResourceTagMappingList |= map(
    select(
      # ours by tag ...
      ((.Tags // []) | map({(.Key): .Value}) | add // {} | .capstone == "tillflow")
      # ... or ours by name, which is how an untagged resource gets caught.
      or (.ResourceARN | contains($p))
      or (((.Tags // []) | map({(.Key): .Value}) | add // {} | .Name // "") | startswith($p))
    )
  )
' <<<"$all_json")"

count="$(jq '.ResourceTagMappingList | length' <<<"$resources_json")"

if [[ "$count" == "0" ]]; then
  if [[ "$MODE" == "--cleanup" ]]; then
    green "PASS  no capstone=tillflow resources remain — teardown is clean."
    exit 0
  fi
  red "FAIL  no resources found with capstone=tillflow. Nothing deployed, or tags are missing."
  exit 1
fi

if [[ "$MODE" == "--cleanup" ]]; then
  red "FAIL  $count resource(s) still tagged capstone=tillflow after destroy:"
  jq -r '.ResourceTagMappingList[].ResourceARN' <<<"$resources_json" | sed 's/^/        /'
  exit 1
fi

# One jq pass over the whole list, emitting "<arn>\t<missing tags>" per offender.
# The obvious shape -- loop over ARNs and re-query the JSON for each -- rescans
# the full list once per resource and spawns a jq per tag, which is O(n^2) and
# visibly slow by the time the stack is a few hundred resources.
while IFS=$'\t' read -r arn missing_list; do
  [[ -z "$arn" ]] && continue
  red "FAIL  $arn"
  printf '        missing/wrong: %s\n' "$missing_list"
  violations=$((violations + 1))
done < <(
  jq -r --argjson required "$(printf '%s\n' "${REQUIRED_TAGS[@]}" | jq -R . | jq -s .)" '
    .ResourceTagMappingList[]
    | . as $r
    | ($r.Tags | map({(.Key): .Value}) | add // {}) as $tags
    | [
        ($required[] | select($tags[.] == null)),
        (if $tags["managed-by"] != null and $tags["managed-by"] != "terraform"
         then "managed-by=terraform (got \($tags["managed-by"]))" else empty end),
        (if $tags["capstone"] != null and $tags["capstone"] != "tillflow"
         then "capstone=tillflow (got \($tags["capstone"]))" else empty end)
      ] as $missing
    | select($missing | length > 0)
    | "\($r.ResourceARN)\t\($missing | join(" "))"
  ' <<<"$resources_json"
)

checked="$count"

if ((violations == 0)); then
  green "PASS  $checked resource(s), all six required tags present."
else
  red   "FAIL  $violations of $checked resource(s) have tag violations."
fi
echo

# ---------------------------------------------------------------------------
# Naming audit
#
# Where the name lives depends on the service:
#   - EC2/VPC resources are addressed by generated ids (vpc-0abc...), so their
#     human name is the `Name` tag -- the ARN can never carry the prefix.
#   - S3, IAM, DynamoDB, ECS, ECR, log groups etc. put the real name in the ARN.
# Check the ARN where it is meaningful, and the Name tag otherwise.
# ---------------------------------------------------------------------------

echo "== Naming audit =="

name_violations=0
# Emit "<arn>\t<Name tag>" once, rather than re-querying the list per ARN.
while IFS=$'\t' read -r arn name_tag; do
  [[ -z "$arn" ]] && continue

  case "$arn" in
    # Identified by generated id -> the Name tag is the name.
    # API Gateway (/apis/k0lz..., /vpclinks/c54l...) and ACM (certificate/uuid)
    # belong here too: the id is server-assigned, so only the tag can carry it.
    *:ec2:*|*:elasticloadbalancing:*|*:apigateway:*|*:acm:*)
      if [[ -z "$name_tag" ]]; then
        red "FAIL  no Name tag: $arn"
        name_violations=$((name_violations + 1))
      elif [[ "$name_tag" != "$PREFIX"* ]]; then
        red "FAIL  Name tag '$name_tag' is not prefixed '$PREFIX': $arn"
        name_violations=$((name_violations + 1))
      fi
      ;;
    # KMS keys are addressed by uuid; the alias carries the name and is checked
    # separately below.
    *:kms:*)
      : ;;
    *:log-group:*)
      [[ "$arn" != *"/${PREFIX}/"* ]] && {
        red "FAIL  log group not under /${PREFIX}/: $arn"
        name_violations=$((name_violations + 1))
      } ;;
    *)
      [[ "$arn" != *"${PREFIX}"* ]] && {
        red "FAIL  missing '${PREFIX}' prefix: $arn"
        name_violations=$((name_violations + 1))
      } ;;
  esac
done < <(
  jq -r '
    .ResourceTagMappingList[]
    | "\(.ResourceARN)\t\((.Tags | map({(.Key): .Value}) | add // {}).Name // "")"
  ' <<<"$resources_json"
)

# KMS aliases carry the prefix that the key ARN cannot.
#
# List the aliases for OUR keys (customer-managed keys tagged into this stack),
# not aliases already matching the prefix -- filtering on the prefix first would
# make the check vacuous: it could only ever see names that already pass.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  alias_name="${line%%$'\t'*}"

  # AWS-managed aliases (alias/aws/...) are not ours to name.
  [[ "$alias_name" == alias/aws/* ]] && continue

  if [[ "$alias_name" != "alias/${PREFIX}"* ]]; then
    red "FAIL  KMS alias on a devops-g1 key is not prefixed: $alias_name"
    name_violations=$((name_violations + 1))
  fi
done < <(
  for key_arn in $(jq -r '.ResourceTagMappingList[].ResourceARN | select(test(":kms:"))' <<<"$resources_json"); do
    key_id="${key_arn##*/}"
    aws kms list-aliases --region "$REGION" --key-id "$key_id" \
      --query 'Aliases[].AliasName' --output text 2>/dev/null | tr '\t' '\n'
  done
)

if ((name_violations == 0)); then
  green "PASS  all $checked resource name(s) carry the '$PREFIX' prefix."
else
  red   "FAIL  $name_violations resource(s) are not prefixed."
fi
echo

total=$((violations + name_violations))
if ((total == 0)); then
  green "AUDIT PASSED — $checked resources, naming and tags conform."
  exit 0
fi
red "AUDIT FAILED — $total violation(s)."
exit 1
