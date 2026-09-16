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

variable "github_owner_id" {
  description = <<-EOT
    Numeric GitHub account id of the repository owner. This org emits OIDC `sub`
    claims in the immutable-identifier format
    (`repo:<owner>@<owner_id>/<repo>@<repo_id>:<trigger>`), so the trust policies
    match on ids rather than names -- ids never change and never transfer.
    Read it from the token claims, or:
      curl -s https://api.github.com/users/<owner> | jq .id
  EOT
  type        = string
  default     = "198869474"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id must be numeric."
  }
}

variable "github_repository_id" {
  description = <<-EOT
    Numeric GitHub repository id. See github_owner_id.
      curl -s https://api.github.com/repos/<owner>/<repo> | jq .id
  EOT
  type        = string
  default     = "1362867461"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must be numeric."
  }
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
    Image per service. Empty by default, which means "use the public bootstrap
    image" (see local.service_image in ecs.tf); the pipeline overrides with a
    digest-pinned image from our own ECR on every deploy.

    The default must NOT reference our own ECR. A digest inside a repository
    this same Terraform creates does not exist on a fresh apply -- or after the
    destroy/rebuild G5 grades -- and every service then fails with
    CannotPullContainerError. The ECR lifecycle policy (keep 20, tagStatus any)
    would expire it eventually even on this account.

    It must also be SELF-HEALTHY: ECS and the ALB probe /health and /ready, so a
    placeholder that serves neither (busybox) crash-loops until a pipeline run.

    Never a `latest` tag anywhere.
  EOT
  type        = map(string)
  default = {
    web        = ""
    pos        = ""
    payments   = ""
    commission = ""
  }
}

variable "service_desired_count" {
  description = <<-EOT
    Running tasks per service; Terraform owns this, the pipeline owns the image.

    Two per HTTP service, so each ALB target group has a healthy target in both
    AZs -- one task cannot demonstrate the AZ-failure drill, and a rolling deploy
    with minimum-healthy-percent 100 needs somewhere to put the new task.

    Only `pos` runs at G1: it is the golden path, and the other services get
    their own code in G2. They share the same self-healthy image, so raising
    them is a one-line change -- kept at 0 for now purely to avoid paying for
    six idle Fargate tasks on a shared cohort account.
  EOT
  type        = map(number)
  default = {
    web        = 0 # own code lands in G2
    pos        = 2 # golden path: proven end to end, one task per AZ
    payments   = 0 # own code lands in G2
    commission = 0 # worker, no ingress; scaled up with its first real workload
  }
}

# --- data tier (ADR 0003) --------------------------------------------------

variable "db_engine_version" {
  description = "PostgreSQL major version (ADR 0003: 16.x, latest minor at apply)."
  type        = string
  default     = "16"
}

variable "db_instance_class" {
  description = "RDS instance class. Burstable Graviton; revisit after k6 (G3)."
  type        = string
  default     = "db.t4g.small"
}

variable "db_multi_az" {
  description = <<-EOT
    Multi-AZ (synchronous standby). ADR 0003 requires it for the RPO~0 story and
    the G4 AZ-failure drill. Set false only to cut cost while iterating, and say
    so in the PR -- it changes the durability claim the SLOs rest on.
  EOT
  type        = bool
  default     = true
}

variable "db_performance_insights" {
  description = <<-EOT
    Performance Insights. Supported on db.t4g.small (verified on the applied
    instance -- see the note in data.tf); unsupported on db.t2/t3.micro. Set
    false if the instance class ever changes to one that refuses it.
  EOT
  type        = bool
  default     = true
}

variable "db_backup_retention_days" {
  description = "Automated backup retention (ADR 0003: 7 days, RPO <= 5 min)."
  type        = number
  default     = 7

  validation {
    condition     = var.db_backup_retention_days >= 1
    error_message = "Retention must be at least 1 day; 0 disables automated backups and breaks the RPO claim in ADR 0003."
  }
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "tillflow"
}

variable "db_master_username" {
  description = "RDS master username. Per-service least-privilege roles are created by the migration job (ADR 0003)."
  type        = string
  default     = "tillflow_admin"
}

variable "redis_engine_version" {
  description = "ElastiCache Valkey engine version."
  type        = string
  default     = "8.0"
}

variable "redis_node_type" {
  description = "ElastiCache node type. Sized after k6 (G3)."
  type        = string
  default     = "cache.t4g.micro"
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
    ALB access logs to S3. The logs bucket + its delivery policy now exist
    (storage.tf), and edge.tf's access_logs block depends on that policy, so
    this defaults on. Flip to false only to save the trickle of S3 cost while
    iterating, never as a way to dodge a missing bucket.
  EOT
  type        = bool
  default     = true
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
