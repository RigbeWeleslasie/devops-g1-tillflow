# Cleanup — purging the k6 abandoned-charge backlog (PR #61 residue)

- **Executed:** 2026-09-29T12:12:26Z–12:12:56Z
- **Target:** `https://ayh1c5n3xd.execute-api.us-east-1.amazonaws.com/api/payments`
- **Operator:** Nebyat, with team sign-off (see PR #63 thread)
- **Endpoint:** `POST /admin/charges/purge-abandoned` (deployed on payments task def 32)

The wrong-branch k6 run (`docs/scar-log.md` 2026-09-29 / PR #61) left tens of thousands of
charges `PENDING` with no `CheckoutRequestID` — the STK push never got a provider reference,
so no callback can ever match them and no money moved. They starved the oldest-first
reconciler and made `/admin/pending` unusable, blocking drill 2.1 step 3 and the restore
reconciliation. Cleared with the purge route (PR #63), team-approved.

## Before / after (the counts the team asked to record)

| Step | Time (UTC) | Response |
| --- | --- | --- |
| Dry-run **before** | 2026-09-29T12:12:26Z | `{"dryRun":true,"wouldDelete":40291,"cutoff":"2026-09-29T11:12:27Z"}` |
| Delete (`dryRun:false`) | 2026-09-29T12:12:27Z | `{"dryRun":false,"deleted":40291}` — HTTP 200, **1.5s** |
| Dry-run **after** | 2026-09-29T12:12:55Z | `{"dryRun":true,"wouldDelete":0}` |
| `GET /admin/pending` after | 2026-09-29T12:12:56Z | `{"count":0}` |

**40,291 abandoned charges deleted; backlog now 0.** Every deleted row was `PENDING`,
`checkout_request_id IS NULL`, `hold_reason IS NULL`, older than 60 minutes — the predicate
that makes them unreachable by any callback (see `services/payments/src/routes/admin.ts` and
the PR #63 review, which confirmed no foreign keys point at `charges`, so nothing is orphaned).

## What this unblocks

- **2.1 step 3** (reconciler surfaces a timed-out charge, still `PENDING`) — re-run against the
  edge, now that the reconciler is not starved.
- **Restore reconciliation** (runbook §2.5 step 4) — the reconciler can be exercised against a
  queryable charge without wading through the backlog.
