variable "aws_region" {
  description = "Assigned AWS region. Fixed by ADR 0002; not overridable per-env."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "TillFlow deploys only in us-east-1 (ADR 0002). Change the ADR first."
  }
}

variable "aws_account_id" {
  description = <<-EOT
    The capstone AWS account (cohort account, group 1). Pinned via the provider's
    `allowed_account_ids` so Terraform refuses to run anywhere else.
  EOT
  type        = string
  default     = "240462142849"

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

variable "vpc_cidr" {
  description = "VPC CIDR. /16 split into /20 subnets across 2 AZs (see network.tf)."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrsubnet(var.vpc_cidr, 4, 0))
    error_message = "vpc_cidr must be a valid IPv4 CIDR with room for /20 subnets (i.e. /16 or larger)."
  }
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

# owner is set per-resource/module (the DRI of that area), not globally.
