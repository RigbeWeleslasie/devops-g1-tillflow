# TillFlow main stack — G0 scaffold.
#
# Real resources are added in G1 across network.tf / data.tf / ecs.tf / edge.tf /
# iam.tf / secrets.tf / pipeline.tf / observability.tf (see infra/README.md).
#
# This file intentionally declares no resources yet so `terraform validate` passes
# on an empty plan during G0.

# Sanity output so `terraform plan` shows the resolved naming context.
output "context" {
  value = {
    region     = var.aws_region
    prefix     = local.prefix
    account_id = local.account_id
    buckets    = local.buckets
    services   = local.services
  }
}
