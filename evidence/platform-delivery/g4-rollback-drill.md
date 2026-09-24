# G4 — broken release / rollback drill (2.4)

**DRI:** Meron — Platform + delivery. Covers `docs/runbook.md` §2.4, whose stated G4 proof
is: *"deploy a controlled failure, detect via smoke, demonstrate rollback."*

**Status:** EXECUTED 2026-09-24, Deploy run **#56**. Detection **2m 03s**, recovery
**4m 11s**, the scripted rollback fired automatically, production ended on the exact
pre-drill revision. The workflow is **red on purpose** — see "a red run is the pass".

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

## The blocker is gone

Earlier versions of this file recorded that `deploy.yml`'s `release` job carries
`environment: prod`, that the environment had **no required reviewer**, and that the job
had therefore never run — every deploy in this project was a manual
`aws ecs update-service`.

That is fixed. The reviewer was configured on 2026-09-22 and Deploy #50 proved the gate
works end to end: the run paused, `nebyathhailu` approved `prod`, and the workflow
completed. So this drill can now exercise the **real pipeline path** rather than the
local `deploy.sh` fallback — which matters, because a rollback proven through
`deploy.sh` is not a rollback proven through the thing that actually deploys.

## Designing the controlled failure

The failure has to be chosen carefully, because **two different mechanisms can roll this
service back and they prove different things**:

| Mechanism | Catches | Whose code |
| --- | --- | --- |
| ECS deployment circuit breaker (`{"enable": true, "rollback": true}`, confirmed live) | a task that will not reach a steady state at all | AWS's |
| `deploy.yml`'s "Rollback on smoke failure" step | a rollout that succeeded and then failed the smoke test | **ours** |

A crash-looping image only ever reaches the circuit breaker, so it tests AWS, not us.
The interesting failure — and the one the runbook's G4 proof asks for — is a deploy that
**starts cleanly and serves the wrong thing**.

`infra/scripts/smoke.sh` gives us exactly that lever. With an expected SHA it asserts the
**running** `/version` reports *that* commit:

```
check /version ".sha == \"${EXPECTED_SHA}\"" "version"
```

So the controlled failure is: **run the release job at a SHA whose image is not what the
service will actually be running.** The task starts, passes its health check, the ALB
target goes healthy, the circuit breaker stays quiet — and smoke fails on the version
assertion, which is precisely the branch we want to exercise.

That is also a realistic failure, not a contrived one. "The deploy reported success but
the old image is still serving" is the exact scenario `smoke.sh`'s own comment says the
SHA assertion exists to catch, and it is invisible to every health check in the stack.

### The cheapest way to produce it

`workflow_dispatch` on `deploy.yml` with the `service` input set to `pos`. The workflow
builds and deploys `github.sha` for the ref it runs on; point it at a ref whose HEAD
commit differs from the image the service ends up running and the assertion fails.

Do **not** ship a deliberately broken application image to ECR for this. It is slower, it
leaves a poisoned artifact in a repository with an immutable-tag policy, and it tests a
different failure (a broken app) than the one being drilled (a deploy that lied).

## Pre-drill capture — 2026-09-22

Taken before anything was touched:

```
task definition   devops-g1-pos:38
running           2/2
live /version     sha 5cf6eae20a5de91788f1a90bb0bc11ec5f208df4
                  digest sha256:3af3ebdd93c10be2ab5846d9962a9daa20584830ecf04aeec67bcd244237e916
circuit breaker   {"enable": true, "rollback": true}
```

**Revision 38 and SHA `5cf6eae` are what the drill must end back on.** Re-capture before
running — another deploy moves these:

```bash
export AWS_PROFILE=devops-lab-new
date -u +%Y-%m-%dT%H:%M:%SZ
aws ecs describe-services --cluster devops-g1 --services devops-g1-pos \
  --region us-east-1 --query 'services[0].taskDefinition' --output text
curl -s https://k0lzgyvn1i.execute-api.us-east-1.amazonaws.com/api/pos/version
```

## Running it

1. Actions → **Deploy** → **Run workflow**, service `pos`, on a ref whose HEAD is not the
   image `pos` will run. Note the UTC time.
2. Approve the `prod` deployment when the run pauses — the same gate Deploy #50 proved.
3. Watch the `release` job. Expect: build/push succeed, `update-service` succeeds, ECS
   reaches steady state, **then** `Post-deploy smoke` fails on the `/version` assertion.
4. The **"Rollback on smoke failure"** step should run automatically — it is conditioned
   on `failure() && steps.smoke.outcome == 'failure'`. Confirm from the log, not from the
   fact that the service recovered; the circuit breaker recovering a service would look
   similar from the outside and would mean something different.
5. The job ends `exit 1`. **A red workflow is the pass condition here** — the drill
   proves a bad release is refused, so a green run would mean the smoke test failed to
   catch it.

## Timeline — executed 2026-09-24 (all UTC)

| Marker | Time | Evidence |
| --- | --- | --- |
| Pre-drill state | 10:13:26 | task definition **39**, `/version` sha `583ff63`, 2/2 running, settled |
| Run triggered | 10:12 | Deploy #56, `workflow_dispatch`, branch `drill/g4-broken-release`, service `pos` |
| `prod` approved (apply) | 10:14 | `meronkahsay` |
| `prod` approved (release) | ~10:31 | `nebyathhailu` — **a second, separate approval**, see below |
| **Bad image live** | **10:35:33** | task definition **40**, `/version` sha `g4drill000…` |
| **Smoke failed** | **~10:37:36** | `FAIL /version` — full output below |
| **Rollback step fired** | ~10:38 | `Warning: rolling back to …/devops-g1-pos:39` |
| Service back on revision 39 | 10:38:41 | `describe-services` |
| **`/version` back to `583ff63`** | **10:39:15** | verified from outside the VPC |
| Deployment settled | 10:41:39 | single deployment, 2/2 running |

**Detection: 2m 03s** (bad image live 10:35:33 → smoke failed ~10:37:36)
**Recovery: 4m 11s** (smoke failed → `/version` correct 10:39:15)
**Total exposure: 3m 42s** (bad image live → correct SHA serving)

### The smoke output — what caught it

```
Run ./infra/scripts/smoke.sh "pos" "4055b8f0c2cce9c20ecf82c94d97e589007e8dcf"
smoking https://k0lzgyvn1i.execute-api.us-east-1.amazonaws.com/api/pos

PASS  /health   {"status":"ok","service":"pos"}
PASS  /ready    {"status":"ready","service":"pos"}
FAIL  /version  {"service":"pos","sha":"g4drill0000000000000000000000000000000d", ...}

SMOKE FAILED — 1 check(s)
Error: Process completed with exit code 1.
```

**`/health` and `/ready` both passed.** That is the whole point. The container was
genuinely healthy, the ALB target was in service, and ECS's deployment circuit breaker
never engaged — because nothing was wrong with the *task*. The only thing wrong was that
the artifact was not the commit the pipeline claimed to have deployed, and exactly one
check in the entire stack tests for that.

### Which mechanism fired

Ours, not AWS's. Verbatim from the Actions log:

```
Run echo "::warning::rolling back to arn:aws:ecs:.../devops-g1-pos:39"
Warning: rolling back to arn:aws:ecs:us-east-1:240462142849:task-definition/devops-g1-pos:39
rolled back
Error: Process completed with exit code 1.
```

That is `deploy.yml`'s **"Rollback on smoke failure"** step, gated on
`failure() && steps.smoke.outcome == 'failure'`, reverting to the task definition it
recorded in the "Record current task definition" step before deploying. The ECS circuit
breaker stayed quiet throughout, as designed — it catches tasks that will not start, and
this task started perfectly.

Distinguishing the two matters: a service that recovers looks identical from the outside
either way, and only one of those outcomes says *our* code works.

### A red run is the pass

The workflow ends `Error: Process completed with exit code 1` — deliberately. The final
line of the rollback step is `exit 1`, so a bad release **fails the pipeline** rather than
reporting success after quietly repairing itself. A green run here would have meant the
smoke test failed to notice a lying artifact.

## What the drill exposed

**The `prod` gate is per-job, not per-run.** `apply` and `release` each carry
`environment: prod`, so each requests its own approval. The run sat in "Waiting" for ~17
minutes after the first approval because the second request was not obvious from the
summary page — it only appears on the job page as *"is waiting for prod deployment
approval"*.

Worse, **the run's triggerer could not approve the second one**: `meronkahsay` triggered
#56 and approved `apply`, but `nebyathhailu` had to approve `release`. That is GitHub
preventing self-review, which is correct as a control but means **a single person cannot
complete a release alone**. Worth knowing before a G5 demo where one person is driving.

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
