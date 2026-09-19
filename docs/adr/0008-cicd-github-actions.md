# ADR 0008 — CI/CD on GitHub Actions, not CodePipeline

- **Status:** Accepted
- **Date:** 2026-09-19
- **DRI:** Meron (Platform + delivery)
- **Required proof:** `.github/workflows/` + a pipeline run deploying a service by digest
  (`docs/ownership.md`, "CI/CD gates & promotion rule")

## Context

`docs/architecture.md` §8 was written at G0 and named two delivery mechanisms: GitHub
Actions for PR checks, and **AWS CodePipeline** (CodeConnections → CodeBuild → scan gate
→ ECR → ECS → smoke → rollback) for deployment.

By G1 the deploy path was built entirely in GitHub Actions and CodePipeline was never
created. This ADR records that decision and the reasoning, because the architecture doc
described a plan that the implementation had moved away from, and a plan that no longer
matches reality is worse than no plan — it sends a reader looking for a console page that
does not exist.

The requirement the gate actually states is a **repeatable, non-manual deploy** (G1:
"Blocked if: manual infra, broken naming/tags, or no repeatable deploy"). It does not
name a product. `docs/ownership.md`'s DRI ledger already records the proof artifact for
this decision as `.github/workflows/` + a pipeline run.

## Decision

**One delivery lane: GitHub Actions.** No CodePipeline, no CodeBuild, no CodeConnections.

| Stage | Where | What runs |
| ----- | ----- | --------- |
| PR | `.github/workflows/pr-checks.yml` | lint, typecheck, tests, secret + dependency + IaC scan (Trivy), Docker build, `terraform plan`, naming/tag audit |
| `main` | `.github/workflows/deploy.yml` | gated `terraform apply` → per-service build/push (SHA + digest) → ECS deploy **by digest** → post-deploy smoke → rollback on failure |
| On demand | `.github/workflows/k6.yml` | k6 load scenarios against the deployed edge |

Supporting properties, unchanged from the original plan:

- **No long-lived AWS keys anywhere.** Actions federates via OIDC into
  `devops-g1-ci-deploy` (push to `main` / `prod` environment) or the read-only
  `devops-g1-ci-plan` (pull requests). See `infra/iam.tf`.
- **No `latest` tags.** Images are tagged with the commit SHA and deployed by immutable
  digest; `/version` reports both at runtime and the smoke test asserts the running SHA
  is the SHA that was built.
- **Path filters** so a change under `services/payments/` builds and deploys only
  Payments plus its `_shared` dependencies.

### Why not CodePipeline

1. **Credentials.** Actions' OIDC federation means no AWS access key exists in GitHub at
   all. Reaching the same posture through CodePipeline still requires CodeConnections to
   GitHub, so the trust relationship does not disappear — it moves, and a second place
   to get wrong is a second place to audit.
2. **One place to look.** PR checks already had to live in Actions (they gate the PR, and
   they run on forks and branches that never reach AWS). Splitting deploy into a
   different product means two log UIs, two failure notification paths, and two things to
   explain in a runbook.
3. **Nothing extra to tear down.** G5 requires destroy/rebuild and a cost account.
   CodePipeline, CodeBuild projects, a CodeConnections link and their artifact bucket are
   all additional stateful resources to create, pay for, and destroy cleanly.
4. **The gate is about properties, not products.** Digest-pinned deploys, a scan gate, a
   post-deploy smoke and automatic rollback are all present. Which service executes them
   is not what is being assessed.

### What this costs us

CodePipeline's native ECS deploy action gives blue/green and automatic rollback as
configuration. In Actions we implement rollback ourselves in `deploy.yml` — it is our
code, so it is our bug if it is wrong, and it is exercised in the G4 broken-release
drill rather than assumed.

## Consequences

- `docs/architecture.md` §8 and `docs/production-readiness.md` are corrected to describe
  the Actions lane. The CodePipeline rows are removed rather than left unchecked, because
  an unchecked box implies unfinished work rather than a decision taken.
- `docs/runbook.md` §2.4 ("Broken release — rollback") referenced the CodePipeline console
  as the first place to confirm an auto-rollback. That is Reliability's file
  (`docs/ownership.md` Area 4); flagged to that DRI rather than edited here.
- The G4 rollback drill must exercise **our** rollback implementation, since there is no
  managed deployment controller behind it.
- If this project ever moves to an org where GitHub is not permitted, the deploy lane has
  to be rebuilt. Accepted: the capstone runs on GitHub by requirement (`docs/gates.md`
  G0: private mono-repo + mentor access).

## Alternatives considered

- **CodePipeline as originally planned** — rejected above.
- **Both, with Actions for PRs and CodePipeline for deploy** — the literal reading of the
  G0 plan. Rejected: it is the two-places-to-look problem with none of the benefit, and
  the deploy lane was already working in Actions by the time the question was live.
- **Actions for PRs, manual `terraform apply` for deploy** — rejected outright: "manual
  infra" is an explicit G1 blocker.
