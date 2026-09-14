terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }

    # Self-signed cert for the internal VPC Link -> ALB hop (see edge.tf).
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # Backend is configured in backend.tf once infra/bootstrap has been applied.
}
