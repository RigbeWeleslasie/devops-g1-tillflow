# worker.tf — the POS sale.paid consumer.
#
# DRI: Meron (Platform + delivery).
#
# Payments marks a charge PAID and relays `sale.paid` to devops-g1-sale-events.
# Nothing consumed it: `local.services` is [web, pos, payments, commission], the
# POS image runs `dist/server.js`, and `dist/worker.js` had no process anywhere.
# Sales stayed UNPAID, the queue filled, and everything ended in the DLQ. The
# IAM was already right (`queue_consume.pos` grants receive/delete) -- there was
# simply nothing holding the grant.
#
# Standalone rather than a fifth entry in `local.services`: that list drives ECR
# repositories, target groups, Cloud Map entries, per-service SGs and log groups,
# and the worker wants none of them. Bending the loop for one member that opts
# out of most of it is worse than writing the pair out.
#
# It reuses POS's task role (already carries the queue and secret grants), POS's
# exec role, POS's security group and POS's log group -- it is the same service,
# a second process.

resource "aws_ecs_task_definition" "pos_worker" {
  family                   = "${local.prefix}-pos-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_exec["pos"].arn
  task_role_arn            = aws_iam_role.task["pos"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name = "pos-worker"

      # The POS image, with a different entrypoint. Same artifact, so the worker
      # and the API can never drift apart in a way a digest would not show.
      image     = local.service_image["pos"] != "" ? local.service_image["pos"] : local.placeholder_image
      essential = true
      command   = ["node", "dist/worker.js"]

      user                   = "1000:1000"
      readonlyRootFilesystem = true
      linuxParameters = {
        initProcessEnabled = true
      }

      # No portMappings, no load balancer, and -- deliberately -- no health check.
      #
      # `services/pos/src/worker.ts` starts no HTTP server: it constructs an SQS
      # event source and calls runForever. An HTTP probe against it would fail
      # every interval, ECS would kill the container, and the circuit breaker
      # would roll the deploy back. A container with no health check is healthy
      # while its process runs, which is the right semantics for a queue consumer.
      #
      # This differs from `commission`, whose worker DOES pass a probe -- because
      # `services/commission/src/health.ts` exists and its worker calls
      # `createHealthServer(...).listen()`. Copying commission's task definition
      # without that file is what made this wrong.
      #
      # Restore the probe when POS's worker grows the same health server (Rigbe's
      # file, tracked separately); it also gives the worker /version artifact
      # identity, which the brief asks for.
      environment = [
        { name = "SERVICE_NAME", value = "pos-worker" },
        { name = "ENVIRONMENT", value = var.environment },
        { name = "PORT", value = tostring(var.app_port) },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "SALE_EVENTS_QUEUE_URL", value = aws_sqs_queue.main["sale-events"].url },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4317" },
        { name = "OTEL_SERVICE_NAME", value = "pos-worker" },
        { name = "OTEL_RESOURCE_ATTRIBUTES", value = "service.name=pos-worker,deployment.environment=${var.environment}" },
      ]

      # The same database as the POS API -- same schema, same role. No
      # SERVICE_TOKEN: the worker makes no service-to-service call, it reads a
      # queue and writes its own schema.
      secrets = [
        { name = "DATABASE_URL", valueFrom = local.db_url_ref["pos"] },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service["pos"].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "worker"
        }
      }

    },

    # Same ADOT sidecar as every other task: a queue consumer's traces are the
    # half of sale -> payment -> callback that the API never sees.
    {
      name      = "adot"
      image     = local.adot_image
      essential = false

      secrets = [{
        name      = "AOT_CONFIG_CONTENT"
        valueFrom = aws_ssm_parameter.adot_config.arn
      }]

      portMappings = [
        { containerPort = 4317, protocol = "tcp", name = "otlp-grpc" },
        { containerPort = 4318, protocol = "tcp", name = "otlp-http" },
      ]

      healthCheck = {
        command     = ["CMD", "/healthcheck"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service["pos"].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "worker-adot"
        }
      }
    },
  ])

  tags = {
    Name    = "${local.prefix}-pos-worker"
    service = "pos"
    owner   = local.service_owner["pos"]
  }
}

resource "aws_ecs_service" "pos_worker" {
  name            = "${local.prefix}-pos-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.pos_worker.arn
  launch_type     = "FARGATE"

  # One consumer, not two. SQS delivers a message to a single consumer at a
  # time, and the sale.paid handler is idempotent on sale_id, so a second task
  # would add redelivery races for no throughput at this volume. Revisit if k6
  # shows the queue backing up (G3).
  # The INITIAL count only. `desired_count` is in `ignore_changes` below, so this
  # is read once at create and never again -- flipping `pos_worker_enabled` on an
  # existing service does nothing. Scaling it up afterwards is:
  #
  #   aws ecs update-service --cluster devops-g1 \
  #     --service devops-g1-pos-worker --desired-count 1
  #
  # 0 by default because the image deployed to `pos` today is the shared
  # reference app, which has no `dist/worker.js`: starting it would crash-loop
  # every task and produce a red service that proves nothing. "An image exists"
  # is not "that image contains a worker", so this stays an explicit decision.
  desired_count = var.pos_worker_enabled && local.service_image["pos"] != "" ? 1 : 0

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # A queue consumer can go to zero briefly during a deploy: messages wait, they
  # are not lost. That is cheaper than running a spare task purely to satisfy a
  # 100% floor on a single-task service.
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 0

  enable_execute_command = true

  network_configuration {
    subnets          = [for s in aws_subnet.private : s.id]
    security_groups  = [aws_security_group.service["pos"].id]
    assign_public_ip = false
  }

  # No load_balancer and no service_registries: nothing routes to it and nothing
  # resolves it by name.

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  tags = {
    Name    = "${local.prefix}-pos-worker"
    service = "pos"
    owner   = local.service_owner["pos"]
  }
}
