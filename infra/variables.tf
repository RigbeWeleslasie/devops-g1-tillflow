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

variable "github_repository" {
  description = "owner/repo — scopes which repository may assume the OIDC deploy role."
  type        = string
  default     = "RigbeWeleslasie/devops-g1-tillflow"

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repository))
    error_message = "github_repository must be in owner/repo form."
  }
}

variable "create_github_oidc_provider" {
  description = <<-EOT
    Create the account-wide GitHub OIDC provider, or adopt an existing one.
    The cohort account is shared, so another group may already have created it;
    it can only exist once per account.
  EOT
  type        = bool
  default     = false
}

variable "vpc_cidr" {
  description = "VPC CIDR. /16 split into /20 subnets across 2 AZs (see network.tf)."
  type        = string
  default     = "10.20.0.0/16"

  # `can(cidrsubnet(...))` alone is too weak: a /28 splits into /32s happily and
  # passes, then network.tf's subnet math fails mid-apply. Check the prefix
  # length directly -- the 4-bit split plus an offset of 8 needs /16 or larger.
  validation {
    condition = (
      can(cidrhost(var.vpc_cidr, 0)) &&
      can(tonumber(split("/", var.vpc_cidr)[1])) &&
      tonumber(split("/", var.vpc_cidr)[1]) <= 16
    )
    error_message = "vpc_cidr must be a valid IPv4 CIDR of /16 or larger (e.g. 10.20.0.0/16); network.tf splits it into /20 subnets at offsets 0,1,8,9."
  }
}

# --- compute / runtime -----------------------------------------------------

variable "app_port" {
  description = "Port every application container listens on."
  type        = number
  default     = 8080
}

variable "task_cpu" {
  description = "Fargate task CPU units (1024 = 1 vCPU). Sized after k6 in G3."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate task memory (MiB). Must be a valid pairing with task_cpu."
  type        = number
  default     = 1024
}

variable "service_images" {
  description = <<-EOT
    Image per service. Digest-pinned by the pipeline on every deploy; the default
    is the shared golden-path image so the platform can be proven before the
    product services exist. Never a `latest` tag.
  EOT
  type        = map(string)
  default = {
    web        = "public.ecr.aws/docker/library/busybox:1.36"
    pos        = "public.ecr.aws/docker/library/busybox:1.36"
    payments   = "public.ecr.aws/docker/library/busybox:1.36"
    commission = "public.ecr.aws/docker/library/busybox:1.36"
  }
}

variable "service_desired_count" {
  description = <<-EOT
    Running tasks per service. Services start at 0 and are scaled up once the
    pipeline has pushed a real image, so an apply never leaves failing tasks
    crash-looping against a placeholder.
  EOT
  type        = map(number)
  default = {
    web        = 0
    pos        = 0
    payments   = 0
    commission = 0
  }
}

# --- edge ------------------------------------------------------------------

variable "api_throttle_burst" {
  description = "API Gateway burst limit (requests). Blunt DoS/cost guard."
  type        = number
  default     = 100
}

variable "api_throttle_rate" {
  description = "API Gateway steady-state rate limit (requests/second)."
  type        = number
  default     = 50
}

variable "enable_alb_access_logs" {
  description = <<-EOT
    ALB access logs to S3. Requires the logs bucket and its delivery policy to
    exist first (created alongside the other buckets), so it is off until then.
  EOT
  type        = bool
  default     = false
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
