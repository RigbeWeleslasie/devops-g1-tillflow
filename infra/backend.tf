# S3 remote state backend.
#
# Created by `infra/bootstrap` (see ADR 0004). Bucket name embeds the account id
# because S3 names are globally unique; the DynamoDB table serialises concurrent
# applies so CI and a laptop can never write state at the same time.
#
#   make bootstrap            # once, local state
#   terraform -chdir=infra init

terraform {
  backend "s3" {
    bucket         = "devops-g1-tfstate-240462142849"
    key            = "tillflow/main/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "devops-g1-tflock"
    encrypt        = true
  }
}
