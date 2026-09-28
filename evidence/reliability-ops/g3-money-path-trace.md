# G3 traces — the money path across two services (sale → pay → Payments → Daraja)

**DRI:** Rigbe (`docs/ownership.md`, "Telemetry (spans/metrics/logs)"). Follows
[`g3-trace-capture.md`](g3-trace-capture.md), which was POS-only. The gate wants a trace that
crosses services; this is it, on the rebuilt stack (2026-09-28).

## What was captured

Trace **`1-8f6203f1-caad6b4b4221e00f162a333d`** — one `POST /api/pos/sales/{id}/pay` against
the live edge (`ayh1c5n3xd`, the API Gateway issued by the G5 rebuild), 2026-09-28
14:49:18 UTC. Raw document: [`g3-money-path-trace.json`](g3-money-path-trace.json).

```bash
aws xray batch-get-traces --profile devops-g1 --region us-east-1 \
  --trace-ids 1-8f6203f1-caad6b4b4221e00f162a333d --output json
```

It is **one trace containing segments from both `pos` and `payments`** — the outbound HTTP
call from POS carries the trace context and Payments continues it. Distributed propagation
works; that is the part the gate asks for.

| Service | Span | Duration | Result |
| --- | --- | --- | --- |
| `pos` | `POST /api/pos/sales/{id}/pay` | 1574 ms | **202** |
| `pos` | &nbsp;&nbsp;outbound `POST payments.devops-g1.internal:8080/charges` | 1554 ms | **500 (fault)** |
| `payments` | `POST /charges` | 1538 ms | **500 (fault)** |
| `payments` | &nbsp;&nbsp;`pg.query:INSERT` (charge row), `UPDATE` | 3 ms, 2 ms | ok |
| `payments` | &nbsp;&nbsp;`tls.connect` to the provider | 492 ms | ok |
| `payments` | &nbsp;&nbsp;`GET …/oauth/v1/generate?grant_type=client_credentials` | 1514 ms | **400 (error)** |

## What the trace says about the money path today — a finding, not just a picture

The flow does **not** complete. Reading the spans in order: Payments writes the charge row,
opens TLS to the real Daraja host, and its OAuth token request (`/oauth/v1/generate`) is
rejected **400**. Payments answers 500, POS records the outcome as unknown, and the sale
response says so: `"charge":{"status":"UNKNOWN","chargeId":null}`, sale stays `UNPAID`.

That is the documented state of `devops-g1/daraja` — sandbox credentials unset — now visible
end to end in a single trace instead of inferred from logs. It also means Payments is
pointed at the real Safaricom sandbox host, not the M-Pesa stub that
`evidence/payments-integrity/drills/README.md` says the deployed drills need.

## What this proves and what it does not

- **Proves:** trace context propagates POS → Payments; Payments' own DB and outbound-HTTP
  spans are exported; the ADOT → X-Ray path works for more than one service, on the rebuilt
  stack.
- **Does not prove the callback leg.** Sale → pay → **callback** needs Daraja (or the stub)
  to answer, so there is no callback to trace yet. That leg stays open and depends on
  `devops-g1/daraja` — Meron/Nebyat, not a Reliability action.
- **Does not cover Commission.** Commission runs from the scheduled daily close, not from the
  sale flow, so it does not appear here; and `/api/commission/ready` was returning **503** at
  capture time.
- No Grafana or console screenshot is attached: per `evidence/README.md` the JSON and the
  command are the evidence.
