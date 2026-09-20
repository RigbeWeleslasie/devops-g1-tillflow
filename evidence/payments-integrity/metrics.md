# Payments & Commission SLI metrics — the emitted contract

**DRI:** Nebyat (Payments + integrity) · **G3** · Last verified 2026-09-18 against `main`.

This is the exact wire contract for the six instruments `services/payments` and
`services/commission` emit. It exists so the alarm author and the dashboard author
do not have to read the source to find out what a label is called — and so that if
one of us changes a label, the diff shows up in a file the other two review.

Names and label keys match `docs/slo-error-budgets.md`'s "Data source" rows. Where
that document named a counter without spelling it (`reconciliation outcome
counter`), the name below is the one now emitted.

---

## Status: emitted, not yet exported

Every instrument below is recorded by the services today and asserted by tests that
run in CI. **None of it reaches CloudWatch yet**, and that is not a bug in this code:

`services/_shared/ts/src/otel.ts` configures a `traceExporter` only. There is no
`metricReader` and no `MeterProvider`, so `@opentelemetry/api` hands back a **no-op
meter** and every `add()` below is discarded in-process. Traces work; metrics do not
leave the task.

That is Meron's `otel.ts` PR (add `OTLPMetricExporter` + `PeriodicExportingMetricReader`).
**The moment it merges, these six start flowing with no change to `services/payments`
or `services/commission`** — no import to add, no bootstrap to call. That is the whole
reason the instrumentation is written against `@opentelemetry/api` rather than the
SDK, exactly as `trace.getActiveSpan()` already is throughout both services.

So the sequencing in the G3 plan holds, with one correction worth having: my half was
**not** blocked on the shared meter. Only the *export* was.

---

## Payments — `services/payments/src/metrics.ts`

### `payments_command_total` · Counter · dimensions `type`, `result`

One Daraja command attempt. Emitted from `chargeService` and `payoutService`, not
from the routes, so any future caller counts the same way.

| `type` | `result` | Meaning | SLI |
| --- | --- | --- | --- |
| `stk` / `b2c` | `accepted` | Daraja acknowledged it. | numerator + denominator |
| `stk` / `b2c` | `uncertain` | No answer at all — timeout or transport error. I5: the charge/payout stays PENDING. | denominator; scored by `payments_reconcile_total`, **not** as an error here |
| `stk` / `b2c` | `rejected` | Daraja refused to initiate. Nothing is in flight. | denominator, **error** |
| `stk` / `b2c` | `idempotent` | A repeat that returned the existing row and sent nothing (I2 / I4). | numerator + denominator |
| `stk` | `late_ack` | An ack that arrived too late to claim its charge. Anomaly, not a success. | denominator, **error** |

A request rejected by validation (HTTP 400) **never reaches this counter** —
`docs/slo-error-budgets.md` excludes client 4xx, and the cleanest way to exclude
something is not to emit it. There is a test for that.

`uncertain` is the label to be careful with. It is *not* an error at command time:
the SLO says a timeout correctly held PENDING and later reconciled counts as
success. Alarming on `uncertain` directly will page on M-Pesa being slow. The thing
that should page is `payments_reconcile_total{outcome="needs_attention"}`.

### `payments_callback_process_seconds` · Histogram · unit `s` · dimensions `kind`, `outcome`

Wall time from receipt to committed outcome for one inbound Daraja callback. The
timer starts **before** parsing, so a malformed body is timed too.

| `outcome` | Meaning | SLI |
| --- | --- | --- |
| `applied_paid` | A legal `PENDING->PAID` transition. | numerator + denominator |
| `applied_declined` | A legal `PENDING->FAILED` from a genuine business decline (cancelled, insufficient funds). A **correct** outcome. | **excluded from both** |
| `duplicate` | Identical redelivery, deduped with zero state writes (I3). | numerator + denominator |
| `unmatched` | No charge/payout carries this reference (threat-model A2). Stored, not applied. | **excluded**; worth its own panel — a rising rate is spoofing or a lost reference |
| `held` | The payment did not reach a terminal state and needs a human: amount mismatch (A1), or a B2C queue timeout. **Real money in limbo.** | denominator, **error** |
| `not_applied` | Matched, but the charge was already terminal. Correct dedupe. | numerator + denominator |
| `contradicted` | The callback claimed success and Daraja's own records said otherwise (G5's confirming query). Changes no state. | denominator, **error** — and the one that should page: nothing legitimate produces it |
| `unconfirmed` | Daraja could not be reached, or does not know yet, so the PAID transition was withheld and the charge left to the reconciler. | denominator; **not** an error — I5 applied to the callback path — but a rising rate means payments are settling late |
| `malformed` | Unparseable body, answered 400. | **excluded** |

`held` and `not_applied` are the pair to get right. On the outcome object they are
identical — matched, not applied, no transition — and they mean opposite things.
They are kept apart by an explicit `heldForReview` field on the outcome, not by
matching on the log message, so rewording a log line cannot silently move a stuck
payment into the "correct no-op" bucket.

`kind` is `stk` or `b2c`.

### `payments_reconcile_total` · Counter · dimension `outcome`

The counter that makes `uncertain` honest. One increment per look at a still-PENDING
charge.

| `outcome` | Meaning |
| --- | --- |
| `resolved_paid` | `stkQuery` said it went through. The uncertainty resolved. |
| `resolved_failed` | `stkQuery` returned a definite decline. |
| `still_pending` | Daraja says it is still processing. |
| `unqueryable` | The push itself timed out, so there is no `CheckoutRequestID` to ask about. Waiting for a late callback to adopt it, or for a human. |
| `query_error` | `stkQuery` itself failed. Not an answer, so not a decision. |
| `needs_attention` | Past `RECONCILE_MAX_ATTEMPTS`. **We have stopped finding out what happened to a real payment.** |

**`needs_attention` is the one that should page.** It is the only signal that I5's
"a timeout is not a decline" has stopped being self-healing. It fires once per charge
that crosses the threshold, not once per look.

---

## Commission — `services/commission/src/metrics.ts`

### `commission_payout_total` · Counter · dimension `state`

What the close did about one attendant's day. The vocabulary is
`payout_ledger.status` lowercased wherever a ledger row exists, so a panel and a
`SELECT status, count(*)` answer the same question the same way.

| `state` | Meaning |
| --- | --- |
| `computed` | A new, payable ledger row. The day's real work. |
| `replayed` | The row was already there; nothing recomputed. |
| `requested` | Payments accepted the B2C request. |
| `skipped_zero` | Commission came to less than one shilling. Nothing M-Pesa can send. Correct, not an error. |
| `skipped_no_msisdn` | The attendant earned commission but has no phone number on file. Money owed to a real person that nobody can send. |
| `uncertain` | The payout request's outcome is unknown. The row stays COMPUTED for the next run. Never FAILED. |
| `rejected` | Payments refused the request. **Error.** |

**`replayed` against `requested` is how "duplicate disbursement = 0" renders.** A
redelivered trigger increments `replayed` and leaves `requested` flat. If both rise
together, the invariant has broken — that is a P1 and a release freeze on
`commission` + `payments` per the SLO doc, not a burn-rate alert.

`skipped_zero` and `skipped_no_msisdn` are deliberately separate series. The first is
rounding dust. The second is money a real person earned, and it needs a different
human — collapsing them hides the second behind the first.

### `commission_run_duration_seconds` · Histogram · unit `s` · dimension `status`

`status` is `completed` or `failed`. A close that threw is timed under `failed` and
never appears as `completed`.

### `commission_run_completed_before_0630` · Gauge · no dimensions

`1` when the close for a business day finished before 06:30 EAT the following
morning (`payoutDeadline()` in `services/commission/src/services/businessDay.ts`),
`0` when it did not, `0` when the run threw.

Two properties that are easy to get wrong and are both tested:

- **Unlabelled.** The obvious dimension is `business_day`, which adds a new time
  series every day — unbounded cardinality, and a gauge that never settles because
  yesterday's series simply stops reporting. One series holding the latest answer is
  what a budget panel can actually read.
- **A pure replay does not write it.** Re-closing 2026-08-01 as a drill in September
  is trivially "after 06:30 on 2026-08-02". Letting the runbook's own replay drill
  flip an SLO gauge red is how people learn to stop trusting the dashboard. A run
  that created nothing and found existing rows is skipped; an *empty* day (created
  nothing, found nothing) is a real close and still counts.

---

## Three things the alarm author needs that are not in the SLO doc

Found while checking these names against `infra/`. Flagging rather than fixing —
`infra/` is Meron's.

1. **The namespace is `TillFlow`, flat.** `infra/ecs.tf:175` sets the `awsemf`
   exporter's `namespace = "TillFlow"`. An alarm written against `TillFlow/payments`
   will sit in `INSUFFICIENT_DATA` forever. Note that `infra/iam.tf:493` grants
   `cloudwatch:PutMetricData` on `TillFlow/${each.key}` — a *different* string. That
   grant is currently unused, because `awsemf` publishes by writing EMF records to
   the `/devops-g1/metrics` log group rather than by calling `PutMetricData`. Worth
   reconciling so the IAM statement does not read as documentation of a namespace
   nothing uses.

2. **`dimension_rollup_option = "NoDimensionRollup"`** (`infra/ecs.tf:177`) means
   CloudWatch gets *only* the exact dimension sets listed above. There is no
   pre-aggregated "all results" series. Every SLI denominator has to be built with
   metric math summing the individual series — e.g. `payments_command_total` summed
   across `result` for a fixed `type`. That is fine, but it has to be written that
   way from the start.

3. **Histograms arrive as StatisticSets** (min/max/sum/count), not percentiles. The
   SLO's "within 60s" gate on `payments_callback_process_seconds` is answerable from
   `Maximum`, or as a ratio of counts if we add a bucket boundary at 60s. It is *not*
   answerable as a p95 from EMF without an explicit percentile configuration.

---

## Verifying

```
npm test --workspace=@tillflow/payments    # 116 tests, 17 of them metrics
npm test --workspace=@tillflow/commission  #  62 tests, 14 of them metrics
```

The metric tests drive the real routes, the real close and the real reconciler
against a real in-memory `MeterProvider` (`test/metricsHarness.ts`) — never by
calling `recordCommand()` directly. Asserting the recorder can count proves nothing
anybody doubted; the claim worth testing is that a successful STK push actually
produces `payments_command_total{type="stk",result="accepted"}`, under that name,
with that unit.

Both suites were falsified before being trusted, per the usual drill:

| Break | Expected failure | Result |
| --- | --- | --- |
| `callbackOutcomeLabel` ignores `heldForReview` | the `held` vs `not_applied` test | failed, alone |
| a timed-out push records `rejected` instead of `uncertain` | the two I5 tests | failed, alone |
| the on-time gauge is written on replays too | the replay-drill test | failed, alone |
| `skipped_no_msisdn` collapsed into `skipped_zero` | the no-MSISDN test | failed, alone |

## Still open

- **Nothing is exported until the shared meter lands.** Until then these tests are
  the only evidence the instruments exist, and the CloudWatch side is unproven.
  The first real confirmation will be an EMF record in `/devops-g1/metrics`.
- **No service is deployed** (`apply: success`, `release: skipped`), so no metric has
  ever left a task. The G3 blocker list depends on that changing.
