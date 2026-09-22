# G4 drills — Payments (2.1, 2.2)

**DRI:** Nebyat · `docs/runbook.md` §2.1, §2.2 · `docs/g4-plan.md` Step 6

Two scripts, one command each, that execute the drill against a target and write a
timed evidence file with the real responses — the record §6 of the plan demands.

| Drill | Script | Proves |
| --- | --- | --- |
| 2.1 uncertain payment | `2.1-uncertain-payment.sh` | **I5** a timeout stays `PENDING`, never `FAILED`, even after the reconciler gives up · **I2** a retry returns the same charge and pushes nothing |
| 2.2 callback replay / reorder | `2.2-callback-replay.sh` | **I3** two network deliveries → one row, one transition, one `sale.paid` · a late callback after resolution applies nothing |

## The prerequisite nobody had spotted

Both drills force ADR 0005's deterministic scenarios — KES 103 (timeout), KES 104
(duplicate callback). **A real Daraja cannot be told to time out or to redeliver.** So
the deployed Payments must be pointed at the **M-Pesa stub-server**, not at Safaricom:

- `MPESA_ADAPTER=daraja` stays as it is (the `prod` guard requires it — correct)
- `devops-g1/daraja` → `base_url` = the stub's address, `consumer_key`/`consumer_secret`
  = any non-empty placeholder (the stub accepts anything)

That is what ADR 0005 always intended ("a tiny HTTP stub service") and what
`k6/README.md` means by "never point BASE_URL at a target running `MPESA_ADAPTER=daraja`"
— it means the sandbox, not the adapter. The stub existed as code but nothing could
build it, which is why every STK push from the deployed Payments timed out and why the
k6 full-flow run produced 115 stuck charges. `services/_shared/mpesa/Dockerfile` is the
missing piece. Deploying it (ECS task or a sidecar in the payments task with
`DARAJA_BASE_URL=http://localhost:9090`) is Platform's; the image is ours.

**Setting Safaricom sandbox credentials would not unblock these drills.** It would make
the money path work against the real sandbox — worth doing for the contract test — but
2.1 and 2.2 need the stub either way.

## Run against AWS

```bash
export BASE_URL=https://<api-gw>.execute-api.us-east-1.amazonaws.com
export SERVICE_TOKEN=$(aws secretsmanager get-secret-value --secret-id devops-g1/service-token --query SecretString --output text)
./evidence/payments-integrity/drills/2.1-uncertain-payment.sh
./evidence/payments-integrity/drills/2.2-callback-replay.sh
```

Each writes `g4-2.x-*-<timestamp>.md` here. Commit it, then fill in the `trace_id`
line from X-Ray. Every assertion is over HTTP via `GET /admin/charges/:id/audit` — no
database access needed.

## Validated locally first

A drill script that has never run is a description, not a tool. `local-stack.mts`
stands up the real Payments HTTP surface on pg-mem and the real `DarajaAdapter` HTTP
path against the stub, on localhost:

```bash
npx tsx evidence/payments-integrity/drills/local-stack.mts   # prints the exports
# in another shell, with those exports:
./evidence/payments-integrity/drills/2.1-uncertain-payment.sh
```

Running them found three things a read-through would not have: the reconcile POST 400'd
on an empty JSON body; step 3 of 2.1 declared PASS without checking anything; and the
"one row, duplicateCount = 1" claim in 2.2 was asserted while its check was skipped —
evidence stating what it had not verified. All three fixed. Then falsified: breaking
callback dedupe in the service makes 2.2 fail with *"2 callback rows for two identical
deliveries (expected 1)"*.

What the local run does **not** prove: the edge (API Gateway → ALB → prefix strip) and
the stub's callback delivery *through* that edge. Those are the two things the AWS run
adds, and the reason it still has to happen.
