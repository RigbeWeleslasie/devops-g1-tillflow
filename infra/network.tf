# network.tf — VPC, subnets, NAT, endpoints.
#
# DRI: Meron (Platform + delivery).
#
# Shape (per docs/architecture.md and the brief's platform baseline):
#   - 2 AZs. Everything that runs our code sits in PRIVATE subnets.
#   - Public subnets exist only for the NAT gateways (and nothing else).
#   - The internal ALB is private; API Gateway reaches it through a VPC Link,
#     so there is no public ingress into the VPC at all.
#   - Egress to Daraja goes out through NAT.
#
# Why one NAT per AZ: a single NAT is cheaper, but it makes the other AZ's tasks
# depend on the NAT AZ staying up -- which would undercut the G4 AZ-failure drill.
# Two NATs keep each AZ independently able to reach Daraja.

locals {
  # 10.20.0.0/16 -> /20 per subnet (4094 usable), 2 AZs x (public, private).
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  public_subnets = {
    for idx, az in local.azs : az => {
      cidr = cidrsubnet(var.vpc_cidr, 4, idx) # 10.20.0.0/20, 10.20.16.0/20
      name = "${local.prefix}-public-${substr(az, -1, 1)}"
    }
  }

  private_subnets = {
    for idx, az in local.azs : az => {
      cidr = cidrsubnet(var.vpc_cidr, 4, idx + 8) # 10.20.128.0/20, 10.20.144.0/20
      name = "${local.prefix}-private-${substr(az, -1, 1)}"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr

  # Required for RDS/ElastiCache/VPC-endpoint DNS names to resolve privately.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name    = local.prefix
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name    = "${local.prefix}-igw"
    service = "platform"
    owner   = "meron"
  }
}

# ---------------------------------------------------------------------------
# Subnets
# ---------------------------------------------------------------------------

resource "aws_subnet" "public" {
  for_each = local.public_subnets

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = each.value.cidr

  # NAT gateways need a public IP; nothing else is placed here.
  map_public_ip_on_launch = false

  tags = {
    Name    = each.value.name
    tier    = "public"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_subnet" "private" {
  for_each = local.private_subnets

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = each.value.cidr

  tags = {
    Name    = each.value.name
    tier    = "private"
    service = "platform"
    owner   = "meron"
  }
}

# ---------------------------------------------------------------------------
# NAT — one per AZ (see header note)
# ---------------------------------------------------------------------------

resource "aws_eip" "nat" {
  for_each = local.public_subnets

  domain = "vpc"

  tags = {
    Name    = "${local.prefix}-nat-${substr(each.key, -1, 1)}"
    service = "platform"
    owner   = "meron"
  }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_nat_gateway" "main" {
  for_each = local.public_subnets

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id

  tags = {
    Name    = "${local.prefix}-nat-${substr(each.key, -1, 1)}"
    service = "platform"
    owner   = "meron"
  }

  depends_on = [aws_internet_gateway.main]
}

# ---------------------------------------------------------------------------
# Route tables
# ---------------------------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name    = "${local.prefix}-public"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# One private route table per AZ so each AZ egresses via its own NAT.
resource "aws_route_table" "private" {
  for_each = local.private_subnets

  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[each.key].id
  }

  tags = {
    Name    = "${local.prefix}-private-${substr(each.key, -1, 1)}"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

# ---------------------------------------------------------------------------
# Flow logs
#
# docs/threat-model.md lists "lateral movement between services" as a threat
# (line 48). Per-service SGs prevent it; flow logs are how we would ever detect
# or investigate an attempt. REJECT-only keeps volume (and cost) low while still
# capturing anything an SG turned away.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/${local.prefix}/vpc-flow-logs"
  retention_in_days = 14

  tags = {
    Name    = "${local.prefix}-vpc-flow-logs"
    service = "platform"
    owner   = "meron"
  }
}

data "aws_iam_policy_document" "flow_logs_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "flow_logs" {
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
    ]
    resources = ["${aws_cloudwatch_log_group.flow_logs.arn}:*"]
  }
}

resource "aws_iam_role" "flow_logs" {
  name               = "${local.prefix}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_assume.json

  tags = {
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_iam_role_policy" "flow_logs" {
  name   = "${local.prefix}-vpc-flow-logs"
  role   = aws_iam_role.flow_logs.id
  policy = data.aws_iam_policy_document.flow_logs.json
}

resource "aws_flow_log" "main" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = "REJECT"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn         = aws_iam_role.flow_logs.arn

  tags = {
    Name    = "${local.prefix}-flow-logs"
    service = "platform"
    owner   = "meron"
  }
}

# ---------------------------------------------------------------------------
# VPC endpoints
#
# ECR/CloudWatch/Secrets traffic would otherwise leave via NAT and be billed per
# GB. Endpoints keep image pulls, log pushes and secret reads on the AWS network
# -- cheaper, and they keep working if NAT is the thing that breaks (G4).
# ---------------------------------------------------------------------------

resource "aws_security_group" "vpce" {
  name        = "${local.prefix}-vpce"
  description = "Interface VPC endpoints: HTTPS from inside the VPC only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from within the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  # Endpoint ENIs only ever answer callers inside the VPC; security groups are
  # stateful, so responses need no egress rule at all. An allow-all-out rule here
  # was copied habit, not a requirement (trivy AWS-0104).
  egress {
    description = "Responses to callers inside the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  tags = {
    Name    = "${local.prefix}-vpce"
    service = "platform"
    owner   = "meron"
  }
}

# Gateway endpoint (free) — S3, for ECR layer pulls and artifact/log access.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for rt in aws_route_table.private : rt.id]

  tags = {
    Name    = "${local.prefix}-vpce-s3"
    service = "platform"
    owner   = "meron"
  }
}

# Interface endpoints — billed hourly, so only the ones a Fargate task needs to
# start and stay observable.
resource "aws_vpc_endpoint" "interface" {
  for_each = toset([
    "ecr.api",        # ECR auth
    "ecr.dkr",        # image pulls
    "logs",           # CloudWatch Logs (awslogs driver)
    "secretsmanager", # db / daraja / slack-webhook secrets
    "ssm",            # ECS exec (debugging without SSH)
    "ssmmessages",    # ECS exec transport
  ])

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for s in aws_subnet.private : s.id]
  security_group_ids  = [aws_security_group.vpce.id]
  private_dns_enabled = true

  tags = {
    Name    = "${local.prefix}-vpce-${replace(each.key, ".", "-")}"
    service = "platform"
    owner   = "meron"
  }
}
