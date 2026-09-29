# G3 money-path trace — a real, fully successful sale → pay → PAID

**Supersedes** [`g3-money-path-trace.md`](g3-money-path-trace.md), which captured the
money path *failing* (Payments' OAuth call to the real Daraja sandbox returned 400,
credentials unset). The review's own re-check (2026-09-29) asked for the passing version
now that `payments` is deployed with the M-Pesa stub sidecar and 2.1/2.2 show clean
`PENDING → PAID` transitions. This is that trace — and finding it clean required fixing a
real bug along the way, not just re-running the same request.

## What was captured

Tenant `f2add323-a56d-404d-908a-8caa0e97cce1`, sale `36206098-8d26-4d1a-9e40-e816277a49b0`,
2026-09-29 18:03–18:09 UTC, against the live edge
(`ayh1c5n3xd.execute-api.us-east-1.amazonaws.com`). Two traces, both clean:

**1. Pay initiation** — [`g3-money-path-trace-passing-pay.json`](g3-money-path-trace-passing-pay.json),
trace `1-228cb606-8e60d77ea6bcca14e797c19e`:

| Span | Duration | Result |
| --- | --- | --- |
| `pos` `POST /api/pos/sales/{id}/pay` | 35 ms | **202** |
| &nbsp;&nbsp;→ `POST payments/charges` | 25 ms | **201** |
| `payments` `POST /charges` | 20 ms | **201** |
| &nbsp;&nbsp;`GET oauth/v1/generate` (stub) | 3 ms | **200** |
| &nbsp;&nbsp;`POST /mpesa/stkpush/v1/processrequest` (stub) | 2 ms | **200** |

**2. Callback** — [`g3-money-path-trace-passing-callback.json`](g3-money-path-trace-passing-callback.json),
trace `1-f9e8f5df-a5dbbc4adad8e70d6d770024`, delivered by the stub ~1s later:

| Span | Duration | Result |
| --- | --- | --- |
| `payments` `POST /callbacks/stk` | 14 ms | **200** |
| &nbsp;&nbsp;`POST /mpesa/stkpushquery/v1/query` (stub) | 1 ms | **200** |

Inside one transaction: `BEGIN` → `INSERT` (callback_events row) → `UPDATE` (charge → PAID)
→ `INSERT` (outbox `sale.paid`) → `COMMIT`. No error, no fault anywhere in either trace.

## Confirmed at every layer, not just from the trace

```bash
curl .../api/payments/admin/charges/4a64dfd7-.../audit
# {"status":"PAID","callbackEvents":[{"applied":true,...}],
#  "outboxEvents":[{"eventType":"sale.paid","publishedAt":"...z"}]}

curl .../api/pos/sales/36206098-...
# {"status":"PAID","paidAt":"2026-09-29T15:03:52.000Z"}
```

Charge PAID, callback applied, outbox event published **and** the POS sale itself reached
`PAID` — the full loop, not just the synchronous half.

## The real bug this surfaced: `pos-worker` was on `busybox` again

The sale did not reach `PAID` on the first check — it sat `UNPAID` for minutes while the
charge was already `PAID` on Payments' side. `devops-g1-pos-worker` was `0/0`, and its
*registered* task definition (`:13`) still pointed at `public.ecr.aws/docker/library/busybox`
— the exact same class of bug as `docs/scar-log.md`'s 2026-09-19 entry, recurring because
the G5 destroy/rebuild's first-apply phase always starts every service at busybox by design
(`docs/runbook.md` §3), and nobody re-ran the `pos-worker` cutover afterward.

**Impact found, not assumed:** a real backlog of **898 messages** on `devops-g1-sale-events`
had accumulated — real `sale.paid` events with nowhere to go.

**Fix:** registered a corrected task definition (`devops-g1-pos-worker:20`, same
`command: ["node","dist/worker.js"]`, image swapped to the real, currently-running `pos`
digest confirmed via `/version`) and cut the service over — `aws ecs register-task-definition`
+ `update-service`, the same direct-API pattern the original scar-log fix used, since
Terraform's `ignore_changes` on `task_definition`/`desired_count` means it can't perform
this cutover itself. **The backlog fully drained: 898 → 0** within about a minute of the
worker coming back up.

## What this proves and what it doesn't

- **Proves:** the full money path — sale, charge, STK push, callback, ledger update, outbox
  publish, and the POS-side consumption that marks the sale `PAID` — works end to end
  through the real deployed edge with the M-Pesa stub.
- **Doesn't prove:** anything about the real Daraja sandbox specifically — the stub, not
  Safaricom, answered every call here. That's by design (`docs/g4-plan.md` §7's decision
  not to point load or drills at the real provider).
- **Worth flagging to the team:** `pos-worker` needs its cutover re-verified after *any*
  future destroy/rebuild — this is the second time this exact bug has recurred, and
  nothing currently alerts on a service silently running the wrong image.
