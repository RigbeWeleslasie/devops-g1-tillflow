/**
 * The POS SLI instrument, named exactly as the "Data source" row of
 * docs/slo-error-budgets.md names it, so the burn-rate alarms can bind to it
 * without a translation table:
 *
 *   pos_sale_write_total{result}
 *
 * One counter, not three, even though that SLO row's prose also says
 * "duplicate-detection counter" and "DB unique-violation counter" — those are
 * `result` label values on this same instrument (`idempotent`,
 * `unique_violation`), the same way `@tillflow/payments`' `recordCommand`
 * folds its own idempotent-replay signal into `payments_command_total`'s
 * `result` label rather than a second counter. One instrument with three
 * result values is one alarm-friendly series to query, not three to keep in
 * sync.
 *
 * Two deliberate choices carried over from payments/src/metrics.ts:
 *
 * 1. **Nothing here registers a MeterProvider.** `@opentelemetry/api` hands
 *    back a no-op meter until `@tillflow/shared/otel`'s `startTelemetry()`
 *    calls `metrics.setGlobalMeterProvider()`. This file is correct and safe
 *    to ship before or after that lands, with no change here.
 * 2. **The instrument is built on first use, not at import.** ESM evaluates
 *    every imported module before an entrypoint's first statement runs, so a
 *    counter created at module scope would capture the no-op meter
 *    permanently. Lazy `??=` construction is the only ordering that can't be
 *    broken by an import moving.
 *
 * Result values:
 * - `ok`               A genuinely new sale written for the first time. In
 *                       the SLI numerator.
 * - `idempotent`        The idempotency-key lookup found an existing row and
 *                       replayed its first response, no second write. Also
 *                       in the numerator — docs/slo-error-budgets.md's POS
 *                       row says so explicitly ("idempotent replay returning
 *                       the first response = success") — recorded under its
 *                       own value so how much of it is happening is visible,
 *                       not folded into `ok`.
 * - `unique_violation`  The SAME outcome as `idempotent`, reached the other
 *                       way: two callers raced past the existence check
 *                       before either committed, and `idempotency_keys`'
 *                       composite primary key resolved it. Recorded
 *                       separately because a nonzero rate here is evidence
 *                       I1's concurrent-safety path is being exercised for
 *                       real in production, not just in a single-threaded
 *                       test — worth seeing on its own, not lost inside
 *                       `idempotent`'s count.
 *
 * A 4xx from bad input (unknown product/attendant, empty line items, a
 * genuine same-key-different-body conflict) records nothing: those are
 * excluded from both halves of the SLI by docs/slo-error-budgets.md's
 * exclusion rules, and counting them here would let a client's bad request
 * burn a budget that was never at risk.
 */
import { metrics, type Counter, type Meter } from '@opentelemetry/api';

export type SaleWriteResult = 'ok' | 'idempotent' | 'unique_violation';

let meter: Meter | undefined;
let saleWriteTotal: Counter | undefined;

function getMeter(): Meter {
  meter ??= metrics.getMeter('@tillflow/pos');
  return meter;
}

export function recordSaleWrite(result: SaleWriteResult): void {
  saleWriteTotal ??= getMeter().createCounter('pos_sale_write_total', {
    description:
      'POST /sales outcomes: a new write, an idempotent replay, or a replay ' +
      'recovered from a concurrent unique-key race. docs/slo-error-budgets.md POS row.',
  });
  saleWriteTotal.add(1, { result });
}
