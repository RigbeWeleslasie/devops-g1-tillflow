# ecs.tf — ECR, ECS cluster, task definitions (app + ADOT sidecar), services.
#
# DRI: Meron (Platform + delivery).
#
# Every backend task runs TWO containers, as the brief requires: the application
# and an ADOT Collector sidecar. The app exports OTLP to localhost:4317 (the two
# containers share a network namespace in awsvpc mode) and the collector forwards
# to CloudWatch/Prometheus and X-Ray.

# ---------------------------------------------------------------------------
# ECR — one repository per service
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "service" {
  for_each = toset(local.services)

  name                 = "${local.prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE" # a tag, once pushed, can never be repointed

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
  }

  tags = {
    Name    = "${local.prefix}/${each.key}"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# Keep the last 20 images per service; expire untagged after a day.
resource "aws_ecr_lifecycle_policy" "service" {
  for_each = aws_ecr_repository.service

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 20 most recent images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Cluster
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = local.prefix

  setting {
    name  = "containerInsights"
    value = "enhanced"
  }

  tags = {
    Name    = local.prefix
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  # FARGATE_SPOT is deliberately not a default: a Spot interruption mid-payment
  # would muddy the failure drills we are graded on. Cost is controlled by task
  # size and by tearing the stack down between sessions instead.
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ---------------------------------------------------------------------------
# Log groups — one per service, plus the ADOT sidecar's own stream
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(local.services)

  name              = "/${local.prefix}/${each.key}"
  retention_in_days = 14

  tags = {
    Name    = "/${local.prefix}/${each.key}"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# ---------------------------------------------------------------------------
# ADOT collector configuration
#
# Held in SSM Parameter Store and read by the sidecar at boot, so the pipeline
# can change collector behaviour without rebuilding application images.
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "adot_config" {
  name        = "/${local.prefix}/adot/config"
  description = "ADOT Collector config shared by every TillFlow task"
  type        = "String"
  tier        = "Standard"

  value = yamlencode({
    receivers = {
      otlp = {
        protocols = {
          grpc = { endpoint = "0.0.0.0:4317" }
          http = { endpoint = "0.0.0.0:4318" }
        }
      }
    }

    processors = {
      # Required before the awsemf/awsxray exporters: enriches spans with ECS
      # metadata (task arn, cluster) so traces are attributable to a task.
      resourcedetection = {
        detectors = ["env", "ecs"]
        timeout   = "2s"
      }
      batch = {
        timeout         = "10s"
        send_batch_size = 512
      }
      memory_limiter = {
        check_interval         = "1s"
        limit_percentage       = 75
        spike_limit_percentage = 15
      }
    }

    exporters = {
      awsxray = {
        region = var.aws_region
      }
      awsemf = {
        region                  = var.aws_region
        namespace               = "TillFlow"
        log_group_name          = "/${local.prefix}/metrics"
        dimension_rollup_option = "NoDimensionRollup"
      }
    }

    service = {
      pipelines = {
        traces = {
          receivers  = ["otlp"]
          processors = ["memory_limiter", "resourcedetection", "batch"]
          exporters  = ["awsxray"]
        }
        metrics = {
          receivers  = ["otlp"]
          processors = ["memory_limiter", "resourcedetection", "batch"]
          exporters  = ["awsemf"]
        }
      }
      telemetry = {
        logs = { level = "info" }
      }
    }
  })

  tags = {
    Name    = "${local.prefix}-adot-config"
    service = "platform"
    owner   = "meron"
  }
}

resource "aws_cloudwatch_log_group" "metrics" {
  name              = "/${local.prefix}/metrics"
  retention_in_days = 14

  tags = {
    Name    = "/${local.prefix}/metrics"
    service = "platform"
    owner   = "meron"
  }
}

# ---------------------------------------------------------------------------
# Security groups
#
# threat-model.md: per-service SGs, no lateral movement, and `commission` must
# have no path to Daraja. Each service gets its own SG so those rules have
# somewhere to live.
# ---------------------------------------------------------------------------

resource "aws_security_group" "service" {
  for_each = toset(local.services)

  name        = "${local.prefix}-${each.key}"
  description = "ECS tasks for ${each.key}"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name    = "${local.prefix}-${each.key}"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# Ingress: only from the ALB, only on the app port. Excludes `commission`: it
# is a worker with no target group/listener (see the load_balancer dynamic
# block below), so an ALB->commission rule would sit open and unused,
# widening its attack surface and silently pre-authorizing any future
# mis-wiring of a listener straight to the worker.
resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  for_each = toset([for s in local.services : s if s != "commission"])

  security_group_id            = aws_security_group.service[each.key].id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"
  description                  = "App traffic from the internal ALB"

  tags = {
    Name    = "${local.prefix}-${each.key}-from-alb"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# Egress: HTTPS only. Enough for ECR, logs, Secrets Manager and (for payments)
# Daraja. Locking `commission` to deny Safaricom specifically is a G2 concern --
# the architectural guarantee is that commission holds no Daraja credentials and
# calls the Payments API instead (docs/architecture.md §3).
resource "aws_vpc_security_group_egress_rule" "service_https" {
  for_each = toset(local.services)

  security_group_id = aws_security_group.service[each.key].id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
  description       = "HTTPS egress (ECR, logs, secrets, Daraja for payments)"

  tags = {
    Name    = "${local.prefix}-${each.key}-https"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# ---------------------------------------------------------------------------
# Task definitions — application + ADOT sidecar
# ---------------------------------------------------------------------------

locals {
  # Until the pipeline pushes the first real image, services run the public
  # ECR "pause"-style placeholder? No -- they run nothing, and desired_count is
  # 0 for services with no image yet. `bootstrap_image` lets the golden-path
  # service come up before any application code exists.
  adot_image = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3"
}

resource "aws_ecs_task_definition" "service" {
  for_each = toset(local.services)

  family                   = "${local.prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_exec[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    # --- application -------------------------------------------------------
    {
      name  = each.key
      image = var.service_images[each.key]

      essential = true

      portMappings = [{
        containerPort = var.app_port
        protocol      = "tcp"
        name          = "http"
      }]

      # Golden path: non-root, read-only root filesystem, no privilege escalation.
      user                   = "1000:1000"
      readonlyRootFilesystem = true
      linuxParameters = {
        initProcessEnabled = true # reap zombies; also required for ECS exec
      }

      environment = [
        { name = "SERVICE_NAME", value = each.key },
        { name = "ENVIRONMENT", value = var.environment },
        { name = "PORT", value = tostring(var.app_port) },
        # Apps export OTLP to the sidecar over the shared localhost.
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4317" },
        { name = "OTEL_SERVICE_NAME", value = each.key },
        { name = "OTEL_RESOURCE_ATTRIBUTES", value = "service.name=${each.key},deployment.environment=${var.environment}" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service[each.key].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "app"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"require('http').get('http://127.0.0.1:${var.app_port}/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }

      # Order startup without coupling liveness.
      #
      # `condition = "START"` only waits for the collector process to start; it
      # does not tie the app's lifetime to the sidecar's. That distinction
      # matters: a stronger condition (HEALTHY/COMPLETE) on a non-essential
      # container is what makes ECS tear the task down when the sidecar exits.
      # START gives the OTLP listener a head start so early spans are not
      # dropped, while a later collector crash still leaves the app serving.
      dependsOn = [{
        containerName = "adot"
        condition     = "START"
      }]
    },

    # --- ADOT collector sidecar -------------------------------------------
    {
      name  = "adot"
      image = local.adot_image

      # Non-essential: if the collector dies we lose telemetry, but the task
      # keeps serving traffic. Losing observability must not cause an outage.
      essential = false

      # Config comes from SSM so it can change without an image rebuild.
      secrets = [{
        name      = "AOT_CONFIG_CONTENT"
        valueFrom = aws_ssm_parameter.adot_config.arn
      }]

      # Exec form, not CMD-SHELL: the collector image is distroless -- no shell,
      # no curl, no wget. `/healthcheck` is the binary the image ships for this.
      # Without a health check there is no signal the collector actually booted,
      # which the G1 gate asks for ("sidecar boot").
      healthCheck = {
        command     = ["CMD", "/healthcheck"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }

      portMappings = [
        { containerPort = 4317, protocol = "tcp", name = "otlp-grpc" },
        { containerPort = 4318, protocol = "tcp", name = "otlp-http" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service[each.key].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "adot"
        }
      }
    },
  ])

  tags = {
    Name    = "${local.prefix}-${each.key}"
    service = each.key
    owner   = local.service_owner[each.key]
  }
}

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "service" {
  for_each = toset(local.services)

  name            = "${local.prefix}-${each.key}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  launch_type     = "FARGATE"

  # 0 until the pipeline has pushed a real image for this service.
  desired_count = var.service_desired_count[each.key]

  # Rolling deploy with circuit breaker: a failing deployment rolls back to the
  # last healthy task set automatically. This is the "broken release" rollback
  # the G4 drill exercises.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  enable_execute_command = true

  network_configuration {
    subnets          = [for s in aws_subnet.private : s.id]
    security_groups  = [aws_security_group.service[each.key].id]
    assign_public_ip = false # private subnets only; egress via NAT
  }

  # The commission worker has no inbound traffic, so no target group.
  dynamic "load_balancer" {
    for_each = each.key == "commission" ? [] : [1]
    content {
      target_group_arn = aws_lb_target_group.service[each.key].arn
      container_name   = each.key
      container_port   = var.app_port
    }
  }

  # Give a new task time to pass health checks before the ALB judges it.
  health_check_grace_period_seconds = each.key == "commission" ? null : 60

  # The pipeline updates the image; Terraform must not fight it by reverting to
  # whatever image the last apply knew about.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  tags = {
    Name    = "${local.prefix}-${each.key}"
    service = each.key
    owner   = local.service_owner[each.key]
  }

  depends_on = [aws_lb_listener.https]
}
