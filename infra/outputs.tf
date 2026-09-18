# Outputs — consumed by later stacks, the audit script and evidence collection.

output "context" {
  description = "Resolved naming/region context; handy as plan evidence."
  value = {
    region     = var.aws_region
    prefix     = local.prefix
    account_id = local.account_id
    buckets    = local.buckets
    services   = local.services
  }
}

output "vpc_id" {
  description = "TillFlow VPC."
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "VPC CIDR block."
  value       = aws_vpc.main.cidr_block
}

output "private_subnet_ids" {
  description = "Private subnets (ECS tasks, RDS, ElastiCache, ALB)."
  value       = [for s in aws_subnet.private : s.id]
}

output "public_subnet_ids" {
  description = "Public subnets (NAT only)."
  value       = [for s in aws_subnet.public : s.id]
}

output "availability_zones" {
  description = "AZs in use."
  value       = local.azs
}

output "nat_public_ips" {
  description = "NAT egress IPs — the addresses Daraja sees from us."
  value       = [for e in aws_eip.nat : e.public_ip]
}

# --- consumed by the GitHub Actions pipeline -------------------------------

output "ci_deploy_role_arn" {
  description = "Role deploy.yml assumes on push to main / the prod environment. Never usable from a pull_request run."
  value       = aws_iam_role.ci_deploy.arn
}

output "ci_plan_role_arn" {
  description = "Read-only role pr-checks.yml's infra-plan job assumes on pull_request."
  value       = aws_iam_role.ci_plan.arn
}

output "ecr_repository_urls" {
  description = "ECR repository URL per service."
  value       = { for k, r in aws_ecr_repository.service : k => r.repository_url }
}

output "ecs_cluster_name" {
  description = "ECS cluster."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_names" {
  description = "ECS service name per service key."
  value       = { for k, s in aws_ecs_service.service : k => s.name }
}

output "api_endpoint" {
  description = "Public API Gateway endpoint — the only ingress."
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "alb_dns_name" {
  description = "Internal ALB DNS (reachable only from inside the VPC)."
  value       = aws_lb.main.dns_name
}

output "uptime_canary_name" {
  description = "External uptime probe Lambda (outside the VPC). Publishes CloudWatchSynthetics/SuccessPercent."
  value       = aws_lambda_function.uptime.function_name
}

output "alerts_topic_arn" {
  description = "SNS topic every G3 alarm publishes to (firing and recovery)."
  value       = aws_sns_topic.alerts.arn
}

output "grafana_workspace_id" {
  description = "AMG workspace id. Used to grant a person access -- see infra/README.md."
  value       = aws_grafana_workspace.main.id
}

output "grafana_workspace_endpoint" {
  description = "Grafana URL. Feed to var.grafana_url so Slack alerts carry a panel link."
  value       = "https://${aws_grafana_workspace.main.endpoint}"
}
