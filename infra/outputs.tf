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
