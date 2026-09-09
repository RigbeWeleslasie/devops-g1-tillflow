provider "aws" {
  region = var.aws_region

  # Baseline tags applied to every taggable resource. Per-resource blocks add/override
  # `owner` and `service`. Required set: group, owner, environment, service,
  # managed-by=terraform, capstone=tillflow.
  default_tags {
    tags = {
      group        = var.group
      environment  = var.environment
      "managed-by" = "terraform"
      capstone     = "tillflow"
      # owner and service are set on individual resources/modules.
    }
  }
}
