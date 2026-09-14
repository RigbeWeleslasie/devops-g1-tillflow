# TillFlow main stack.
#
# DRI: Meron (Platform + delivery). Everything here is Terraform-managed --
# console changes earn no evidence credit (brief, §3).
#
# Files:
#   network.tf        VPC, subnets, NAT, VPC endpoints           [G1]
#   iam.tf            OIDC CI role, task/exec roles              [G1]
#   ecs.tf            cluster, services, task defs + ADOT sidecar [G1]
#   edge.tf           API Gateway, VPC Link, internal ALB         [G1]
#   data.tf           RDS, ElastiCache, SQS + DLQ, EventBridge    [G1]
#   secrets.tf        Secrets Manager references                  [G1]
#   pipeline.tf       CodePipeline / CodeBuild                     [G1]
#   observability.tf  alarms, dashboards, synthetic probe          [G3]
#   outputs.tf        outputs consumed by CI + the audit script
