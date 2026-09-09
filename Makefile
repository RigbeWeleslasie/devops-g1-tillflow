# TillFlow / devops-g1 — one-command lifecycle.
# G0: targets are placeholders; wired for real in G1.

.PHONY: help bootstrap deploy smoke destroy plan fmt validate audit

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

bootstrap: ## Create tfstate bucket + DynamoDB lock (one-time, local state)
	cd infra/bootstrap && terraform init && terraform apply

plan: ## terraform plan for the main stack
	terraform -chdir=infra init && terraform -chdir=infra plan

deploy: ## Apply infra + trigger the pipeline (CI does this on main)
	terraform -chdir=infra init && terraform -chdir=infra apply

smoke: ## Post-deploy smoke tests (health/ready/version + e2e sale)
	@echo "TODO(G1): scripts/smoke.sh"

destroy: ## Tear everything down (main stack, then bootstrap)
	terraform -chdir=infra destroy
	cd infra/bootstrap && terraform destroy

fmt: ## terraform fmt
	terraform -chdir=infra fmt -recursive

validate: ## terraform validate
	terraform -chdir=infra init -backend=false && terraform -chdir=infra validate

audit: ## Naming + tag audit; check no devops-g1-* resources remain after destroy
	@echo "TODO(G1): infra/scripts/audit.sh"
