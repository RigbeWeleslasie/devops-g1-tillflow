# S3 remote state backend.
#
# Enable AFTER `infra/bootstrap` has created the bucket + lock table.
# Fill <ACCOUNT_ID> (or use `-backend-config` / a backend.hcl file in CI).
#
# terraform {
#   backend "s3" {
#     bucket         = "devops-g1-tfstate-<ACCOUNT_ID>"
#     key            = "tillflow/main/terraform.tfstate"
#     region         = "us-east-1"
#     dynamodb_table = "devops-g1-tflock"
#     encrypt        = true
#   }
# }
