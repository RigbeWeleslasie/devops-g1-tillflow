# G4 — broken release / rollback drill (2.4)

**DRI:** Meron — Platform + delivery. Covers `docs/runbook.md` §2.4, whose stated G4 proof
is: *"deploy a controlled failure, detect via smoke, demonstrate rollback."*

**Status:** NOT YET EXECUTED.

## What is actually being tested

There are **two independent rollback mechanisms**, and the drill should say which one
fired rather than treating "it recovered" as one fact:

1. **The pipeline's scripted rollback** — `.github/workflows/deploy.yml`'s "Rollback on
   smoke failure" step records the pre-deploy task definition and, if
   `infra/scripts/smoke.sh` fails, calls `aws ecs update-service --task-definition
   <previous>`. This is *our code*, so it is our bug if it is wrong. That is exactly why
   the runbook says to confirm it fired in the Actions log.
2. **ECS's deployment circuit breaker** — confirmed enabled on `devops-g1-pos`
   (`{"enable": true, "rollback": true}`). This is AWS's backstop if a new task cannot
   reach a steady state at all.

They catch different failures. The circuit breaker catches a task that *won't start*.
The scripted rollback catches a task that starts fine and serves the wrong thing — a
bad build, a broken route, a wrong SHA. The second is the more interesting one, and the
harder to detect, so it is the one this drill should exercise.

There is **no CodePipeline** in this stack (ADR 0008). Do not go looking for a console
that does not exist — `docs/runbook.md` §2.4 step 1 is explicit about this.

## Blocker — read before planning this

The `release` job in `deploy.yml` carries `environment: prod`. That GitHub environment
has **no required reviewer configured**, so the job has never run — every deploy in this
project so far has been a manual `aws ecs update-service`.

So the honest position is:

- **Route A (preferred).** Configure the `prod` environment reviewer first
  (`docs/gates.md` G0 lists this as an open item, owner: platform DRI). Then the drill
  exercises the *real* pipeline path and simultaneously produces G5's "fresh-commit
  release" evidence. One fix, three gate items.
- **Route B (fallback).** Run `infra/scripts/deploy.sh` locally, which has the identical
  record-then-rollback fallback. This proves the mechanism but **not** the pipeline. If
  the drill is run this way, say so plainly — claiming a pipeline rollback that never ran
  through the pipeline is the kind of thing G5's "cannot defend owned work" blocker is
  designed to catch.

## Designing the controlled failure

The failure must be one that **starts cleanly and fails smoke**, otherwise the circuit
breaker catches it first and the scripted path is never exercised.

`infra/scripts/smoke.sh` asserts three things through the public edge: `/health` is
`ok`, `/ready` is `ready`, and — when given an expected SHA — that `/version` reports
*that* SHA. The third is the release gate: a deploy that "succeeded" but left the old
image running fails there.

The cleanest controlled failure is therefore a **deliberate readiness failure**: an image
whose `/ready` returns 503 while the container itself runs happily. The task reaches
steady state (so the circuit breaker stays quiet), the ALB target never goes healthy,
smoke fails on `/ready`, and the scripted rollback has to do the work.

Do **not** use a crash-looping image for this: that is a circuit-breaker test, which is
AWS's code, not ours.

## Pre-drill capture

```bash
export AWS_PROFILE=devops-lab-new
date -u +%Y-%m-%dT%H:%M:%SZ

# The revision we must end up back on
aws ecs describe-services --cluster devops-g1 --services devops-g1-pos \
  --region us-east-1 --query 'services[0].taskDefinition' --output text

# The SHA currently serving, from outside
curl -s https://k0lzgyvn1i.execute-api.us-east-1.amazonaws.com/api/pos/version
```

Record both. The drill is only complete when `/version` is back to this SHA.

## Timeline — fill in

| Marker | UTC | Evidence |
| --- | --- | --- |
| Pre-deploy task definition | | `describe-services` output |
| Pre-deploy `/version` SHA | | `curl` output |
| Bad release deployed | | Actions run link, or `deploy.sh` output |
| Smoke failed | | the failing assertion, verbatim |
| Rollback triggered | | Actions log line / script output — **name which mechanism** |
| Service stable on previous revision | | `describe-services` |
| `/version` back to pre-deploy SHA | | `curl` output |
| **Detection time** | deploy → smoke fail | |
| **Recovery time** | smoke fail → `/version` correct | |

## What "done" requires

- The rollback was **automatic**, not a human running `update-service`. If a human had to
  intervene, that is the finding — record it as such rather than presenting a manual
  recovery as an automatic one.
- `/version` reports the pre-deploy SHA, verified from outside the VPC.
- Which of the two mechanisms fired is named explicitly.
- A `docs/scar-log.md` entry if anything behaved unexpectedly.

## Cleanup

The bad image stays in ECR — tags are immutable and it is harmless once nothing
references it. Note its tag in the write-up so nobody redeploys it by accident.
