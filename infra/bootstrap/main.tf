# infra/bootstrap — one-time remote-state backing store.
#
# Run with LOCAL state (no backend block here). Creates the S3 state bucket, the
# DynamoDB lock table, and a KMS key for state encryption. After apply, uncomment
# the backend block in ../backend.tf and `terraform init -migrate-state` the main stack.
#
# G0: scaffold. Resource bodies are filled in at G1 per ADR 0004.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      group        = "g1"
      owner        = "meron"
      environment  = "prod"
      service      = "platform"
      "managed-by" = "terraform"
      capstone     = "tillflow"
    }
  }
}

data "aws_caller_identity" "current" {}

# --- G1: aws_kms_key.state, aws_s3_bucket.tfstate (+ versioning, SSE-KMS,
#         public-access-block, policy), aws_dynamodb_table.tflock ---

output "state_bucket" {
  value = "devops-g1-tfstate-${data.aws_caller_identity.current.account_id}"
}

output "lock_table" {
  value = "devops-g1-tflock"
}
