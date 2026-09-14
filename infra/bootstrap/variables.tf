variable "aws_region" {
  description = "Assigned AWS region. Fixed by ADR 0002."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "TillFlow deploys only in us-east-1 (ADR 0002). Change the ADR first."
  }
}

variable "aws_account_id" {
  description = <<-EOT
    The capstone AWS account. Terraform refuses to run against any other account
    (provider `allowed_account_ids`), so a wrong/forgotten AWS_PROFILE fails before
    it creates anything. Set it in terraform.tfvars -- see terraform.tfvars.example.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account id."
  }
}

variable "name_prefix" {
  description = "Group prefix for every nameable resource."
  type        = string
  default     = "devops-g1"
}

variable "environment" {
  description = "Deployment environment tag."
  type        = string
  default     = "prod"
}

variable "group" {
  description = "Group identifier tag."
  type        = string
  default     = "g1"
}

variable "state_bucket_extra_principal_arns" {
  description = <<-EOT
    Extra IAM principal ARNs allowed to read/write the Terraform state bucket,
    beyond account root and the ci-deploy/ci-plan roles (infra/iam.tf) which
    are always allowed. Needed for the human operator's own IAM role/user so
    the first manual `terraform init -migrate-state` on the main stack works
    before ci-deploy exists. Example: your admin role's ARN in
    terraform.tfvars. Leave empty once CI is the only thing that touches state.
  EOT
  type        = list(string)
  default     = []
}
