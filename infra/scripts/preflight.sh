#!/usr/bin/env bash
#
# preflight.sh -- run before a hand-run `terraform apply`.
#
# DRI: Meron (Platform + delivery).
#
#   ./infra/scripts/preflight.sh
#
# Catches the one failure mode that has bitten this project twice and is
# invisible in `terraform plan` output unless you read every line:
#
#   Terraform AUTO-LOADS infra/terraform.tfvars. That file is gitignored and
#   written by deploy.sh, so it holds whatever digest YOUR machine last
#   deployed. If a teammate has deployed since, your copy is stale -- and a
#   bare `terraform apply` silently rewrites their task definitions back to
#   your older image, or to the busybox placeholder for any service your copy
#   records as "".
#
# It did exactly that to devops-g1-migrate-pos during G4 drill 2.5, which is
# why the restore drill could not verify row counts (docs/scar-log.md).
#
# CI is not affected: deploy.yml passes `-var 'service_images={}'` explicitly,
# which overrides the file. This is a human-at-a-terminal problem.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
CLUSTER="${CLUSTER:-devops-g1}"
PREFIX="${NAME_PREFIX:-devops-g1}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tfvars="${repo_root}/infra/terraform.tfvars"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

if [[ ! -f "$tfvars" ]]; then
  green "PASS  no local terraform.tfvars -- nothing can be silently reverted."
  dim   "      A bare apply will use the variable defaults (empty images)."
  exit 0
fi

echo "Comparing infra/terraform.tfvars against what is actually deployed"
echo "cluster: ${CLUSTER}  region: ${REGION}"
echo

# Fail closed. An expired token makes every describe-services call return
# nothing, which would otherwise read as "no running services" and PASS -- the
# check reporting safe precisely when it cannot see anything. A preflight that
# can be satisfied by being blind is worse than no preflight.
if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
  red "FAIL  cannot reach AWS -- credentials expired or profile not set."
  dim  "      This check compares against LIVE state; without it a pass means"
  dim  "      nothing. Refresh credentials and re-run."
  exit 1
fi

drift=0
checked=0

for svc in web pos payments commission; do
  # What the local tfvars would apply.
  want="$(sed -n "s/^[[:space:]]*${svc}[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$tfvars" | head -1)"

  # What the service is running right now. A service at desiredCount 0 has
  # nothing to protect, so it is not drift -- only a RUNNING service can be
  # reverted out from under someone.
  read -r desired td <<<"$(aws ecs describe-services \
    --cluster "$CLUSTER" --services "${PREFIX}-${svc}" --region "$REGION" \
    --query 'services[0].[desiredCount,taskDefinition]' --output text 2>/dev/null || echo "0 none")"

  [[ "$desired" == "0" || "$desired" == "None" || "$td" == "none" ]] && continue

  live="$(aws ecs describe-task-definition --task-definition "$td" --region "$REGION" \
    --query "taskDefinition.containerDefinitions[?name=='${svc}'].image | [0]" \
    --output text 2>/dev/null || echo "")"

  checked=$((checked + 1))

  if [[ -z "$want" ]]; then
    red "FAIL  ${svc}: tfvars records NO image, but the service is running"
    red   "      ${live}"
    red   "      An apply would replace it with the busybox placeholder."
    drift=$((drift + 1))
  elif [[ "$want" != "$live" ]]; then
    red "FAIL  ${svc}: tfvars disagrees with what is deployed"
    red   "      tfvars: ${want}"
    red   "      live  : ${live}"
    red   "      An apply would roll the service back to the tfvars image."
    drift=$((drift + 1))
  else
    green "PASS  ${svc}: tfvars matches the running image"
  fi
done

echo
if (( drift == 0 )); then
  if (( checked == 0 )); then
    red "FAIL  tfvars exists but no service is running to compare it against."
    dim  "      Either the cluster is empty (fine -- delete the file) or the"
    dim  "      lookup failed. Not treating 'saw nothing' as 'saw no problem'."
    exit 1
  fi
  green "PREFLIGHT PASSED -- ${checked} running service(s), no silent revert."
  exit 0
fi

red "PREFLIGHT FAILED -- ${drift} service(s) would be reverted by a bare apply."
echo
dim "Fix by one of:"
dim "  1. Refresh the file:      rm infra/terraform.tfvars && ./infra/scripts/deploy.sh <svc>"
dim "  2. Apply CI's way:        terraform apply -var 'service_images={}'"
dim "     (leaves running services alone -- desired_count and task_definition"
dim "      are in ignore_changes, ecs.tf)"
dim "  3. Delete it:             rm infra/terraform.tfvars"
exit 1
