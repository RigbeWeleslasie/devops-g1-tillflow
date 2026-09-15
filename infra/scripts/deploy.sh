#!/usr/bin/env bash
#
# deploy.sh — build, push and deploy one service by immutable digest.
#
# DRI: Meron (Platform + delivery).
#
# The same sequence GitHub Actions runs (.github/workflows/deploy.yml), kept as a
# script so a deploy is reproducible from a laptop and the pipeline has no logic
# that exists only inside YAML.
#
#   ./infra/scripts/deploy.sh pos
#
# No `latest` tags: the image is tagged with the commit SHA, and what gets
# deployed is the digest that tag resolves to.

set -euo pipefail

SERVICE="${1:?usage: deploy.sh <web|pos|payments|commission>}"
REGION="${AWS_REGION:-us-east-1}"
CLUSTER="${CLUSTER:-devops-g1}"
PREFIX="${NAME_PREFIX:-devops-g1}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

account="$(aws sts get-caller-identity --query Account --output text)"
registry="${account}.dkr.ecr.${REGION}.amazonaws.com"
repo="${registry}/${PREFIX}/${SERVICE}"

sha="$(git -C "$repo_root" rev-parse HEAD)"
short="$(git -C "$repo_root" rev-parse --short HEAD)"

if ! git -C "$repo_root" diff --quiet HEAD 2>/dev/null; then
  echo "WARNING: working tree is dirty — the image will be tagged $short but will"
  echo "         not match that commit. Commit first for reproducible evidence."
fi

echo "service : $SERVICE"
echo "account : $account"
echo "commit  : $sha"
echo

# --- record what is running now, so we can roll back -----------------------
previous="$(aws ecs describe-services --cluster "$CLUSTER" \
  --services "${PREFIX}-${SERVICE}" \
  --query 'services[0].taskDefinition' --output text)"
echo "current task definition: $previous"

# --- build + push ----------------------------------------------------------
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$registry" >/dev/null

docker build --platform linux/amd64 --provenance=false \
  --build-arg "COMMIT_SHA=$sha" \
  --build-arg "SERVICE_NAME=$SERVICE" \
  -t "${repo}:${sha}" \
  "${repo_root}/services/_shared/docker"

docker push "${repo}:${sha}"

digest="$(aws ecr describe-images \
  --repository-name "${PREFIX}/${SERVICE}" \
  --image-ids "imageTag=${sha}" \
  --query 'imageDetails[0].imageDigest' --output text)"

image="${repo}@${digest}"
echo "digest  : $digest"

# --- register a revision pointing at the digest ----------------------------
# Only the image changes; the sidecar, roles and limits stay exactly as
# Terraform defined them.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

aws ecs describe-task-definition --task-definition "${PREFIX}-${SERVICE}" \
  --query 'taskDefinition' --output json > "$tmp/td.json"

# The digest only exists after the push, so it cannot be a build arg -- it is
# injected here, which is also where the deployed truth lives. /version then
# reports both the commit and the exact image running.
jq --arg img "$image" --arg svc "$SERVICE" --arg digest "$digest" '
  .containerDefinitions = (
    .containerDefinitions | map(
      if .name == $svc then
        .image = $img
        | .environment = (
            [ (.environment // [])[] | select(.name != "IMAGE_DIGEST") ]
            + [{ name: "IMAGE_DIGEST", value: $digest }]
          )
      else . end
    )
  )
  | del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
        .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)
' "$tmp/td.json" > "$tmp/new-td.json"

task_def="$(aws ecs register-task-definition \
  --cli-input-json "file://$tmp/new-td.json" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"
echo "registered: $task_def"

# --- deploy ----------------------------------------------------------------
# No --desired-count: scale is Terraform's (var.service_desired_count), the
# image is the pipeline's. Forcing a number here would silently undo any scaling
# applied between deploys, and it is what deploy.yml deliberately stopped doing.
aws ecs update-service --cluster "$CLUSTER" \
  --service "${PREFIX}-${SERVICE}" \
  --task-definition "$task_def" >/dev/null

# Scale up on the first deploy.
#
# Terraform sets the initial count but then ignores it (ecs.tf lifecycle), so a
# service that has never been deployed sits at 0. Deploying IS the event that
# makes a service runnable -- it is the first moment a real image exists -- so
# the pipeline owns this transition. The target comes from Terraform's variable,
# not a number invented here, so the two cannot drift.
desired="$(aws ecs describe-services --cluster "$CLUSTER" \
  --services "${PREFIX}-${SERVICE}" \
  --query 'services[0].desiredCount' --output text)"

if [[ "$desired" == "0" ]]; then
  want="$(sed -n "/variable \"service_desired_count\"/,/^}/p" \
    "${repo_root}/infra/variables.tf" |
    sed -n "s/^[[:space:]]*${SERVICE}[[:space:]]*=[[:space:]]*\([0-9]\+\).*/\1/p" | head -1)"
  want="${want:-2}"

  echo "${PREFIX}-${SERVICE} is at 0 — first deploy, scaling to ${want}"
  aws ecs update-service --cluster "$CLUSTER" \
    --service "${PREFIX}-${SERVICE}" \
    --desired-count "$want" >/dev/null
fi

# Keep Terraform's view of this service in step with what was just deployed.
# Nothing records the release in git (a committed digest would break the G5
# rebuild -- the repository is recreated empty), so the local tfvars is written
# here, gitignored, and rebuilt by the next deploy.
tfvars="${repo_root}/infra/terraform.tfvars"
python3 - "$tfvars" "$SERVICE" "$image" <<'PY'
import pathlib, re, sys
path, svc, image = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
services = ["web", "pos", "payments", "commission"]
cur = {s: "" for s in services}
if p.exists():
    for s in services:
        m = re.search(rf'^\s*{s}\s*=\s*"([^"]*)"', p.read_text(), re.M)
        if m:
            cur[s] = m.group(1)
cur[svc] = image
body = "\n".join(f'  {s:<10} = "{cur[s]}"' for s in services)
p.write_text(
    "# Deployed images -- written by infra/scripts/deploy.sh, gitignored.\n"
    "#\n"
    "# NOT committed: a digest inside our own ECR does not exist after the G5\n"
    "# destroy/rebuild, and an auto-loaded tfvars would make CI try to pull it.\n"
    "# First apply on a rebuilt account:  terraform apply -var 'service_images={}'\n"
    f"service_images = {{\n{body}\n}}\n"
)
PY
echo "recorded in infra/terraform.tfvars (gitignored)"

echo "waiting for the service to stabilise..."
if ! aws ecs wait services-stable --cluster "$CLUSTER" --services "${PREFIX}-${SERVICE}"; then
  echo "service did not stabilise; the deployment circuit breaker should have rolled back."
  exit 1
fi

# --- smoke, with rollback on failure ---------------------------------------
if "${repo_root}/infra/scripts/smoke.sh" "$SERVICE" "$sha"; then
  echo
  echo "DEPLOYED  $SERVICE  $short  $digest"
else
  echo
  echo "SMOKE FAILED — rolling back to $previous"
  aws ecs update-service --cluster "$CLUSTER" \
    --service "${PREFIX}-${SERVICE}" \
    --task-definition "$previous" >/dev/null
  aws ecs wait services-stable --cluster "$CLUSTER" --services "${PREFIX}-${SERVICE}"
  echo "rolled back."
  exit 1
fi
