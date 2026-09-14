# S3 remote state backend.
#
# Created by `infra/bootstrap` (see ADR 0004). Bucket name embeds the account id
# because S3 names are globally unique; the DynamoDB table serialises concurrent
# applies so CI and a laptop can never write state at the same time.
#
#   make bootstrap            # once, local state
#   terraform -chdir=infra init

# `kms_key_id` is required, not optional: with only `encrypt = true` the backend
# sends `x-amz-server-side-encryption: AES256`, which the bucket policy denies
# (ADR 0004 mandates the CMK). Naming the key makes the backend send `aws:kms`.
# See docs/scar-log.md.

terraform {
  backend "s3" {
    bucket         = "devops-g1-tfstate-240462142849"
    key            = "tillflow/main/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "devops-g1-tflock"
    encrypt        = true
    kms_key_id     = "alias/devops-g1-tfstate"
  }
}
