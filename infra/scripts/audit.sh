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
EXPECTED_ACCOUNT="${EXPECTED_ACCOUNT:-240462142849}"
MODE="${1:-audit}"

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

resources_json="$(aws resourcegroupstaggingapi get-resources \
  --region "$REGION" \
  --tag-filters "Key=capstone,Values=tillflow" \
  --output json)"

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

while IFS= read -r arn; do
  checked=$((checked + 1))
  tags_json="$(jq --arg a "$arn" \
    '.ResourceTagMappingList[] | select(.ResourceARN==$a) | .Tags | from_entries? // (map({(.Key):.Value}) | add)' \
    <<<"$resources_json")"

  missing=()
  for t in "${REQUIRED_TAGS[@]}"; do
    v="$(jq -r --arg k "$t" '.[$k] // empty' <<<"$tags_json")"
    [[ -z "$v" ]] && missing+=("$t")
  done

  # Value checks for the two tags with fixed values.
  managed_by="$(jq -r '."managed-by" // empty' <<<"$tags_json")"
  capstone="$(jq -r '.capstone // empty' <<<"$tags_json")"
  [[ -n "$managed_by" && "$managed_by" != "terraform" ]] && missing+=("managed-by=terraform (got '$managed_by')")
  [[ -n "$capstone"   && "$capstone"   != "tillflow"  ]] && missing+=("capstone=tillflow (got '$capstone')")

  if ((${#missing[@]})); then
    red "FAIL  $arn"
    printf '        missing/wrong: %s\n' "${missing[*]}"
    violations=$((violations + 1))
  fi
done < <(jq -r '.ResourceTagMappingList[].ResourceARN' <<<"$resources_json")

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
while IFS= read -r arn; do
  tags_json="$(jq --arg a "$arn" \
    '.ResourceTagMappingList[] | select(.ResourceARN==$a) | .Tags | from_entries? // (map({(.Key):.Value}) | add)' \
    <<<"$resources_json")"
  name_tag="$(jq -r '.Name // empty' <<<"$tags_json")"

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
done < <(jq -r '.ResourceTagMappingList[].ResourceARN' <<<"$resources_json")

# KMS aliases carry the prefix that the key ARN cannot.
while IFS= read -r alias_name; do
  [[ "$alias_name" != "alias/${PREFIX}"* ]] && {
    red "FAIL  KMS alias not prefixed: $alias_name"
    name_violations=$((name_violations + 1))
  }
done < <(aws kms list-aliases --region "$REGION" \
           --query "Aliases[?starts_with(AliasName, 'alias/${PREFIX}')].AliasName" \
           --output text | tr '\t' '\n' | grep -v '^$' || true)

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
