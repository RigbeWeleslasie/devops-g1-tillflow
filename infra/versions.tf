terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }

    # Generates the RDS master password (secrets.tf). The value lives in state
    # and in Secrets Manager, never in Git.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }

    # Zips the uptime probe and Slack renderer (observability.tf) at plan time
    # so the source stays reviewable as plain files in infra/alerting/.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Backend is configured in backend.tf once infra/bootstrap has been applied.
}
