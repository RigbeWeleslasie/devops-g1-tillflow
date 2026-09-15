# Deployed images — written by the pipeline, committed so `terraform apply`
# reproduces what is actually running.
#
# NOT in variables.tf: a default pointing at our own ECR breaks a fresh apply
# and the G5 destroy/rebuild (the repository is created by this same Terraform,
# so the digest does not exist yet). Keeping it here means the defaults stay
# rebuildable while this file records the current release.
#
# After a rebuild: leave this file out, `terraform apply` (services at 0), then
# `./infra/scripts/deploy.sh pos` pushes the first image and this file is
# regenerated from the digest it produced.
service_images = {
  web        = ""
  pos        = "240462142849.dkr.ecr.us-east-1.amazonaws.com/devops-g1/pos@sha256:dde9e44dc6977b72d190243e8893f78bfb9dbda6b4cc5f044241a4010bb80a4f"
  payments   = ""
  commission = ""
}
