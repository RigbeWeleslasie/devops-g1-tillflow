/**
 * The Commission SLI instruments, named exactly as the "Data source" row of
 * docs/slo-error-budgets.md names them:
 *
 *   commission_payout_total{state}
 *   commission_run_duration_seconds{status}
 *   commission_run_completed_before_0630        (gauge, 1 or 0)
 *
 * The same three choices as services/payments/src/metrics.ts, for the same
 * reasons — nothing here registers a MeterProvider, instruments are built on
 * first use rather than at import, and exclusions are expressed as labels
 * rather than as silence. See that file's header for the full argument.
 *
 * One difference, and it matters: the *durations* come from
 * `performance.now()`, but the 06:30 deadline decision comes from the injected
 * `now()`. A duration measured on a frozen test clock would always be zero; a
 * deadline evaluated against the wall clock would be untestable. They are
 * different kinds of time and they use different clocks on purpose.
 */
import { metrics, type Counter, type Gauge, type Histogram, type Meter } from '@opentelemetry/api';

/**
 * What the close did about one attendant's day. The vocabulary is
 * `payout_ledger.status` lowercased wherever a ledger row exists, so a panel
 * and a `SELECT status, count(*)` answer the same question the same way.
 *
 * - `computed`           A new, payable ledger row. The day's real work.
 * - `replayed`           The row was already there, so nothing was recomputed.
 *                        This is I4 visible as a number: a redelivered trigger
 *                        shows up here and NOT in `requested`.
 * - `requested`          Payments accepted the B2C request for this row.
 * - `skipped_zero`       Commission came to less than one shilling, so there is
 *                        nothing M-Pesa can send. Ledgered SKIPPED with the
 *                        remainder recorded. A correct outcome, not an error.
 * - `skipped_no_msisdn`  The attendant earned commission but has no phone
 *                        number on file. Also ledgered SKIPPED — but this one
 *                        is money owed to a real person that nobody can send,
 *                        so it is counted separately and belongs on a panel.
 * - `uncertain`          The payout request's outcome is unknown (the HTTP call
 *                        failed). The row stays COMPUTED and the next run
 *                        re-requests it; idempotency-on-ledgerId makes that
 *                        safe. Never FAILED.
 * - `rejected`           Payments refused the request outright. An error.
 */
export type PayoutState =
  | 'computed'
  | 'replayed'
  | 'requested'
  | 'skipped_zero'
  | 'skipped_no_msisdn'
  | 'uncertain'
  | 'rejected';

export type RunStatus = 'completed' | 'failed';

let meter: Meter | undefined;
let payoutTotal: Counter | undefined;
let runSeconds: Histogram | undefined;
let onTimeGauge: Gauge | undefined;

function getMeter(): Meter {
  meter ??= metrics.getMeter('@tillflow/commission');
  return meter;
}

export function recordPayout(state: PayoutState, count = 1): void {
  if (count <= 0) return;
  payoutTotal ??= getMeter().createCounter('commission_payout_total', {
    description: "What the daily close did about each attendant's day, in payout_ledger's own vocabulary.",
  });
  payoutTotal.add(count, { state });
}

export function recordRunDuration(status: RunStatus, seconds: number): void {
  runSeconds ??= getMeter().createHistogram('commission_run_duration_seconds', {
    description: 'Wall time of one daily close, from the close_runs row being opened to it being finished.',
    unit: 's',
  });
  runSeconds.record(seconds, { status });
}

/**
 * The Commission SLO's on-time gauge: 1 when the close for a business day
 * finished before 06:30 EAT the following morning, 0 when it did not.
 *
 * Unlabelled on purpose. The obvious label would be `business_day`, which adds
 * a new time series every single day — unbounded cardinality, and a gauge that
 * never settles because yesterday's series just stops reporting. One series
 * that holds the latest answer is what a budget panel can actually read.
 *
 * A pure REPLAY must not write this (see `runClose`). Re-closing 2026-08-01 as
 * a drill in September is, trivially, "after 06:30 on 2026-08-02" — and letting
 * a drill flip an SLO gauge red is how people learn to stop trusting the
 * dashboard.
 */
export function recordRunOnTime(onTime: boolean): void {
  onTimeGauge ??= getMeter().createGauge('commission_run_completed_before_0630', {
    description:
      '1 when the daily close for a business day finished before 06:30 EAT the next morning, 0 when it did not. ' +
      'Not written by a replay of an already-closed day.',
  });
  onTimeGauge.record(onTime ? 1 : 0);
}

/** Start timing a close. Returns elapsed SECONDS, the unit the instrument declares. */
export function startTimer(): () => number {
  const started = performance.now();
  return () => (performance.now() - started) / 1000;
}
