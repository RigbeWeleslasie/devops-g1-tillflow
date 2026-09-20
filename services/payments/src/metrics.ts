/**
 * The Payments SLI instruments, named exactly as the "Data source" row of
 * docs/slo-error-budgets.md names them, so the burn-rate alarms can bind to
 * them without a translation table:
 *
 *   payments_command_total{type,result}
 *   payments_callback_process_seconds{kind,outcome}
 *   payments_reconcile_total{outcome}        ("reconciliation outcome counter")
 *
 * Three deliberate choices:
 *
 * 1. **Nothing here registers a MeterProvider.** These instruments come from
 *    `@opentelemetry/api`, which hands back a no-op meter until something
 *    calls `metrics.setGlobalMeterProvider()` — which is what
 *    `@tillflow/shared/otel`'s `startTelemetry()` will do once its OTLP metric
 *    reader lands. So this file is correct and safe to ship *before* that: it
 *    records into a no-op today and starts exporting the day the reader
 *    arrives, with no change here. This is exactly how `trace.getActiveSpan()`
 *    is already used throughout this service.
 *
 * 2. **Instruments are built on first use, not at import.** ESM evaluates every
 *    imported module before the first statement of an entrypoint runs, so an
 *    instrument created at module scope would capture the no-op meter
 *    permanently — before `startTelemetry()` ever ran. `server.ts` dodges that
 *    today with dynamic `await import()`, but that is a property of one file
 *    that a future refactor could silently undo. Building lazily is the only
 *    ordering that cannot be broken by an import moving.
 *
 * 3. **Exclusions are labels, not silence.** docs/slo-error-budgets.md excludes
 *    genuine business declines and malformed/spoofed callbacks from the SLI. We
 *    still count them — as `applied_declined` and as `unmatched`/`malformed` —
 *    so the alarm math subtracts them by label while a dashboard can still show
 *    them. Nothing that happened to real money is invisible.
 *
 * Durations come from `performance.now()`, never from the injected `now()`.
 * The injected clock is frozen in tests and stepped by `advance()`, which is
 * exactly what makes state transitions testable and what would make every
 * duration read 0.
 */
import { metrics, type Counter, type Histogram, type Meter } from '@opentelemetry/api';

/** Which Daraja command. */
export type CommandType = 'stk' | 'b2c';

/**
 * What became of one command attempt.
 *
 * - `accepted`    Daraja acknowledged it. In the SLI numerator.
 * - `uncertain`   No answer at all (timeout / transport). I5: the charge or
 *                 payout stays PENDING. NOT an error at command time — the SLO
 *                 says a timeout correctly held PENDING and later reconciled
 *                 counts as success — so this is scored by what reconciliation
 *                 makes of it, via `payments_reconcile_total`.
 * - `rejected`    Daraja refused to initiate. Nothing is in flight. We failed
 *                 to place the command: an error.
 * - `idempotent`  A repeat that correctly returned the existing charge/payout
 *                 and sent nothing (I2 / I4). A success, and the metric that
 *                 shows the invariant holding under load.
 * - `late_ack`    An ack that arrived too late to claim its charge — the row
 *                 was already resolved or already held a CheckoutRequestID.
 *                 Recorded on its own because two provider references for one
 *                 charge is an anomaly an operator wants to see, not a success.
 */
export type CommandResult = 'accepted' | 'uncertain' | 'rejected' | 'idempotent' | 'late_ack';

export type CallbackKind = 'stk' | 'b2c';

/**
 * What one inbound callback did. Flat rather than a cross product of
 * (applied × transition × matched): CloudWatch metric math filters on
 * dimension values, and one dimension with six values is far easier to write
 * an alarm against than three dimensions to be intersected.
 *
 * - `applied_paid`     A legal PENDING->PAID transition. Numerator.
 * - `applied_declined` A legal PENDING->FAILED transition from a genuine
 *                      business decline (cancelled, insufficient funds). A
 *                      CORRECT outcome — excluded from both halves of the SLI.
 * - `duplicate`        An identical redelivery, deduped with zero state writes
 *                      (I3). Correct behaviour; counted so we can see how much
 *                      of it Daraja actually does.
 * - `unmatched`        No charge/payout carries this reference (threat-model
 *                      A2). Stored and not applied. Excluded from the SLI, and
 *                      worth a panel of its own: a rising unmatched rate is
 *                      either a spoofing attempt or a reference we lost.
 * - `held`             The payment did not reach a terminal state and now needs
 *                      a human or the reconciler: the callback's amount
 *                      disagreed with ours (A1), or Daraja sent a B2C queue
 *                      timeout. This IS an error — real money is in limbo —
 *                      and it is the label that must never be confused with
 *                      `not_applied`.
 * - `not_applied`      Matched, but the guarded transition matched no row —
 *                      the charge was already terminal. Correct dedupe.
 * - `contradicted`     The callback claimed success and Daraja's own records
 *                      said otherwise (G5's confirming query). A hold, like
 *                      `held`, but reported apart from it because nothing
 *                      legitimate produces this: an amount mismatch is usually
 *                      a bug somewhere, a contradiction is someone forging
 *                      callbacks. This one should page.
 * - `unconfirmed`      We could not reach Daraja, or Daraja does not know yet,
 *                      so the PAID transition was withheld and the charge left
 *                      to the reconciler. NOT an error — it is I5 applied to
 *                      the callback path — but a rising rate means the
 *                      confirming query is degrading and payments are being
 *                      settled late.
 * - `malformed`        Unparseable body, answered 400. Excluded from the SLI;
 *                      counted so a broken sender is visible.
 */
export type CallbackOutcomeLabel =
  | 'applied_paid'
  | 'applied_declined'
  | 'duplicate'
  | 'unmatched'
  | 'held'
  | 'contradicted'
  | 'unconfirmed'
  | 'not_applied'
  | 'malformed';

/**
 * What one reconciliation look concluded. This is the counter that closes I5:
 * `uncertain` commands are only honestly "not an error" if something finds out
 * later, and `needs_attention` is the label that says it never did.
 */
export type ReconcileOutcome =
  | 'resolved_paid'
  | 'resolved_failed'
  | 'still_pending'
  | 'unqueryable'
  | 'query_error'
  | 'needs_attention';

let meter: Meter | undefined;
let commandTotal: Counter | undefined;
let callbackSeconds: Histogram | undefined;
let reconcileTotal: Counter | undefined;

function getMeter(): Meter {
  meter ??= metrics.getMeter('@tillflow/payments');
  return meter;
}

export function recordCommand(type: CommandType, result: CommandResult): void {
  commandTotal ??= getMeter().createCounter('payments_command_total', {
    description: 'Daraja commands placed by Payments, by type and what became of the attempt.',
  });
  commandTotal.add(1, { type, result });
}

export function recordCallback(kind: CallbackKind, outcome: CallbackOutcomeLabel, seconds: number): void {
  callbackSeconds ??= getMeter().createHistogram('payments_callback_process_seconds', {
    description:
      'Wall time to process one inbound Daraja callback, from receipt to committed outcome. ' +
      'The SLO gate is a terminal transition within 60s of receipt.',
    unit: 's',
  });
  callbackSeconds.record(seconds, { kind, outcome });
}

export function recordReconcile(outcome: ReconcileOutcome, count = 1): void {
  if (count <= 0) return;
  reconcileTotal ??= getMeter().createCounter('payments_reconcile_total', {
    description: 'Reconciliation outcomes: what a look at a still-PENDING charge concluded.',
  });
  reconcileTotal.add(count, { outcome });
}

/**
 * Start timing a callback. Returns elapsed SECONDS — the unit the instrument
 * declares, converted here so no caller can get it wrong.
 */
export function startTimer(): () => number {
  const started = performance.now();
  return () => (performance.now() - started) / 1000;
}

/**
 * The shape both callback outcomes share, structurally. Typed here rather than
 * imported so this module depends on nothing in `services/` — it is imported
 * by the services, and a cycle would be a real ordering hazard given how
 * carefully the lazy init above is arranged.
 */
export interface CallbackOutcomeShape {
  recorded: 'new' | 'duplicate';
  matched: boolean;
  applied: boolean;
  transition: 'PENDING->PAID' | 'PENDING->FAILED' | null;
  /** Set only where the service put the charge/payout on hold for a human (A1). */
  heldForReview?: boolean;
  /**
   * What the confirming stkQuery concluded, on the STK path. Absent on the B2C
   * path: Daraja exposes no equivalent query for a disbursement, so a B2C
   * result callback cannot be confirmed the same way (see metrics.md).
   */
  confirmation?: 'confirmed' | 'contradicted' | 'unconfirmed' | 'skipped' | 'not-required';
}

/**
 * Derive the metric label from an outcome.
 *
 * Deliberately NOT string-matching on `reason`. `held` and `not_applied` both
 * arrive as `matched && !applied && transition === null`, and they mean
 * opposite things for the SLI — a hold is a payment that never reached its
 * terminal state (an error), while an already-terminal charge is correct
 * dedupe. The services set `heldForReview` explicitly at the two places that
 * write a hold, so that distinction is carried, not guessed from prose that a
 * later edit could reword.
 */
export function callbackOutcomeLabel(o: CallbackOutcomeShape): CallbackOutcomeLabel {
  if (o.recorded === 'duplicate') return 'duplicate';
  if (!o.matched) return 'unmatched';
  if (o.applied) return o.transition === 'PENDING->PAID' ? 'applied_paid' : 'applied_declined';

  // Checked before `heldForReview`, which a contradiction also sets: both are
  // holds, and only one of them means someone is forging callbacks. Collapsing
  // them would put a security event and a bookkeeping mismatch on the same
  // alarm, at which point the alarm has to be tuned for the common one.
  if (o.confirmation === 'contradicted') return 'contradicted';
  if (o.confirmation === 'unconfirmed') return 'unconfirmed';

  if (o.heldForReview) return 'held';
  return 'not_applied';
}
