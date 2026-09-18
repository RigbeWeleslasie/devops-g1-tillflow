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

    # Packages the Synthetics canary script (observability.tf) into the zip
    # layout the nodejs runtime requires. Built at plan time so the probe's
    # source stays reviewable as plain JS in infra/canary/ rather than a blob.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Backend is configured in backend.tf once infra/bootstrap has been applied.
}
