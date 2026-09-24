# G5 — fresh-commit release, through the pipeline

**DRI:** Meron — Platform + delivery. Covers G5's *"fresh-commit release, live proof"* and
the proof artifact `docs/ownership.md` names for the CI/CD decision: *"`.github/workflows/`
+ a pipeline run deploying a single service by SHA/digest."*

**Status:** EXECUTED 2026-09-24. Deploy run **#52**, all four services released green.

## Why this is the first one

Every deploy in this project before today was a hand-run `aws ecs update-service`. Not by
choice: `deploy.yml`'s `release` job carries `environment: prod`, and that GitHub
environment had **no required reviewer configured**. GitHub treats a protected environment
with no reviewers as permanently un-runnable, so the job had never started once.

The reviewer was configured on 2026-09-22. Deploy #50 proved the gate works (the run
paused, `nebyathhailu` approved, the workflow completed) but its release job still skipped
— that commit touched only docs and scripts, and the path filter correctly produced an
empty service list.

Run #52 is the first release where the job actually **ran**: the merge of PR #46 touched
`services/_shared/`, which every service depends on, so all four released.

## The release

| | |
| --- | --- |
| Run | Deploy #52 |
| Commit | `583ff63360d06fe016009cea4b480a8e8e5a7f6b` (merge of PR #46) |
| Approved by | `prod` environment reviewer, before any build started |
| Services released | `web`, `pos`, `payments`, `commission` — the full matrix |

Observed from outside, on `pos`:

| Marker | UTC | Evidence |
| --- | --- | --- |
| Pre-release state | 09:02:22 | task definition **38**, `/version` sha `5cf6eae`, 2/2 running |
| Task definition registered | ~09:10:10 | **39** — Terraform-registered, digest-pinned |
| New SHA serving at the edge | **09:11:16** | `/version` → `583ff63` |
| Deployment settled | 09:13:05 | single deployment, 2/2 running |

The gap between 09:10:10 and 09:11:16 is the rolling update: revision 39 was registered,
then ECS drained the old tasks and the ALB shifted traffic. `/version` flipping is the
part that matters — it is asserted from **outside the VPC**, through the real edge, so it
proves the artifact a user reaches is the commit that was built.

## What this demonstrates for the gate

- **Deploy by immutable digest, not a tag.** Revision 39 pins
  `sha256:2686daa9afa592c528eec5bf1b277bc519b6685adc08485406cb5d29a5851f3d`. No `latest`
  anywhere in the stack (ADR 0008, `docs/architecture.md` §8).
- **The running artifact is the built commit, asserted not assumed.**
  `infra/scripts/smoke.sh` takes the expected SHA and fails the release if `/version`
  reports anything else — a deploy that "succeeded" while leaving the old image serving
  fails the gate rather than passing quietly.
- **The release is gated.** A human approves `prod` before anything is built or deployed,
  which is the promotion rule `docs/ownership.md` records as a critical decision.
- **Rollback exists on the same path.** `deploy.yml`'s "Rollback on smoke failure" step
  records the pre-deploy task definition and reverts to it if smoke fails. That branch is
  exercised deliberately in `g4-rollback-drill.md`; this run is its happy path.

## Reproduce

Push to `main` touching any service directory (or `services/_shared/`, which fans out to
all four), then approve the `prod` deployment in Actions. Confirm from outside:

```bash
curl -s https://k0lzgyvn1i.execute-api.us-east-1.amazonaws.com/api/pos/version
aws ecs describe-services --cluster devops-g1 --services devops-g1-pos \
  --region us-east-1 --query 'services[0].taskDefinition' --output text \
  --profile devops-lab-new
```

A commit touching only `docs/` or `infra/scripts/` will **not** release — the path filter
skips it by design, which is why Deploy #50 shows a skipped release job rather than a
failed one.
