data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # devops-g1-<name>
  prefix = var.name_prefix

  # S3 bucket names must be globally unique -> append account id.
  buckets = {
    tfstate   = "${var.name_prefix}-tfstate-${local.account_id}"
    artifacts = "${var.name_prefix}-artifacts-${local.account_id}"
    logs      = "${var.name_prefix}-logs-${local.account_id}"
    backups   = "${var.name_prefix}-backups-${local.account_id}"
    evidence  = "${var.name_prefix}-evidence-${local.account_id}"
  }

  services = ["web", "pos", "payments", "commission"]

  # Owner tag per service area (DRI). See docs/ownership.md.
  service_owner = {
    web        = "rigbe"
    pos        = "rigbe"
    payments   = "nebyat"
    commission = "nebyat"
  }
}
