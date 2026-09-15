# TillFlow / devops-g1 — one-command lifecycle.
#
# DRI: Meron (Platform + delivery).
#
# Every target pins AWS_PROFILE. The workstation's `default` profile points at an
# unrelated account, and Terraform's provider `allowed_account_ids` would refuse
# it anyway -- this makes the right thing the easy thing.

AWS_PROFILE ?= devops-lab-new
AWS_REGION  ?= us-east-1
ACCOUNT_ID  ?= 240462142849
SERVICE     ?= pos

export AWS_PROFILE
export AWS_REGION

TF      := terraform -chdir=infra
TF_BOOT := terraform -chdir=infra/bootstrap

.PHONY: help bootstrap init plan apply deploy smoke destroy fmt validate audit whoami outputs

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

whoami: ## Show which AWS account/identity the targets will use
	@aws sts get-caller-identity --output table

bootstrap: ## One-time: create the tfstate bucket + DynamoDB lock (local state)
	$(TF_BOOT) init -input=false
	$(TF_BOOT) apply -input=false
	@echo
	@echo "Now copy the backend_config output into infra/backend.tf, then: make init"

init: ## Initialise the main stack against the S3 backend
	$(TF) init -input=false

plan: ## terraform plan for the main stack
	$(TF) plan -input=false

apply: ## Apply the main stack (CI does this on main via OIDC)
	$(TF) apply -input=false

deploy: ## Build, push and deploy one service by digest (SERVICE=pos)
	./infra/scripts/deploy.sh $(SERVICE)

smoke: ## Post-deploy smoke: /health /ready /version via API Gateway (SERVICE=pos)
	./infra/scripts/smoke.sh $(SERVICE)

audit: ## Naming + tag audit (the G1 gate check)
	./infra/scripts/audit.sh

audit-clean: ## Assert nothing is left after destroy (the G5 cleanup check)
	./infra/scripts/audit.sh --cleanup

outputs: ## Show stack outputs
	$(TF) output

fmt: ## terraform fmt
	terraform fmt -recursive infra/

validate: ## terraform validate
	$(TF) validate

destroy: ## Tear down the main stack, then the bootstrap state store
	$(TF) destroy
	@echo
	@echo "Main stack destroyed. Verify with: make audit-clean"
	@echo "The state store is deliberately separate -- destroy it only when finished:"
	@echo "  $(TF_BOOT) destroy"
