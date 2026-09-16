/**
 * Reconciliation — I5's other half. "A timeout is not a decline" is only
 * honest if something eventually finds out what actually happened.
 *
 * Every few minutes, for each charge still PENDING past a threshold:
 *   - It has a CheckoutRequestID -> ask Daraja (stkQuery) and resolve it
 *     through the SAME guarded transition the callback path uses.
 *   - Daraja says "still processing" -> count the attempt, leave it PENDING.
 *   - It has NO CheckoutRequestID (the push itself timed out) -> there is
 *     nothing to query. It waits for a late callback to adopt it
 *     (callbackService.findAdoptableCharge) or for a human.
 *
 * Two things this never does:
 *   - Auto-fail. Past RECONCILE_MAX_ATTEMPTS a charge is surfaced for an
 *     alert and stays PENDING. Marking a payment FAILED that Daraja might
 *     have taken money for is the one unrecoverable mistake here.
 *   - Hold a transaction across the network. stkQuery happens outside; the
 *     transaction opens only to apply the answer, re-reading the charge so
 *     a callback that landed meanwhile still wins the guard.
 */
import { trace } from '@opentelemetry/api';
import { isUncertainOutcome, STK_RESULT, type MpesaAdapter } from '@tillflow/mpesa';
import type { Db } from '../db.js';
import { LOCK_KEY, withAdvisoryLock, withTransaction } from '../db.js';
import type { ChargeRow } from '../types.js';
import { applyChargeResolution } from './resolution.js';

export interface ReconcileOptions {
  db: Db;
  adapter: MpesaAdapter;
  /** Only consider charges older than this. */
  afterMs: number;
  /** Past this many queries, stop asking and raise an alert. Never auto-fail. */
  maxAttempts: number;
  batchSize?: number;
  now?: () => Date;
  logger?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export interface ReconcileSummary {
  examined: number;
  resolvedPaid: number;
  resolvedFailed: number;
  stillPending: number;
  unqueryable: number;
  needsAttention: number;
  errors: number;
}

const DESC_BY_CODE: Record<number, string> = {
  [STK_RESULT.SUCCESS]: 'The service request is processed successfully.',
  [STK_RESULT.INSUFFICIENT_FUNDS]: 'The balance is insufficient for the transaction',
  [STK_RESULT.CANCELLED_BY_USER]: 'Request cancelled by user',
  [STK_RESULT.USER_TIMEOUT]: 'DS timeout user cannot be reached',
};

/** Charges the reconciler has given up asking about. These drive the Slack alert. */
export async function chargesNeedingAttention(db: Db, maxAttempts: number): Promise<ChargeRow[]> {
  const res = await db.query<ChargeRow>(
    `SELECT * FROM charges
     WHERE status = 'PENDING'
       AND (hold_reason IS NOT NULL
            OR reconcile_attempts >= $1
            OR (checkout_request_id IS NULL AND reconcile_attempts >= $1))
     ORDER BY created_at`,
    [maxAttempts],
  );
  return res.rows;
}

export async function runReconcileOnce(opts: ReconcileOptions): Promise<ReconcileSummary> {
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 50;
  const cutoff = new Date(now().getTime() - opts.afterMs).toISOString();

  const summary: ReconcileSummary = {
    examined: 0,
    resolvedPaid: 0,
    resolvedFailed: 0,
    stillPending: 0,
    unqueryable: 0,
    needsAttention: 0,
    errors: 0,
  };

  const candidates = await opts.db.query<ChargeRow>(
    `SELECT * FROM charges
     WHERE status = 'PENDING'
       AND hold_reason IS NULL
       AND created_at <= $1
       AND reconcile_attempts < $2
     ORDER BY created_at
     LIMIT ${batchSize}`,
    [cutoff, opts.maxAttempts],
  );

  for (const charge of candidates.rows) {
    summary.examined++;
    const span = trace.getActiveSpan();
    span?.setAttributes({ 'payments.charge_id': charge.id, 'payments.reconcile': true });

    // No CheckoutRequestID: the push timed out and Daraja never told us what
    // to call this. Nothing to query. Count the look so it eventually
    // surfaces for a human, and move on.
    if (!charge.checkout_request_id) {
      summary.unqueryable++;
      await bumpAttempt(opts.db, charge.id, now());
      if (charge.reconcile_attempts + 1 >= opts.maxAttempts) summary.needsAttention++;
      opts.logger?.warn(
        { chargeId: charge.id, saleId: charge.sale_id, attempts: charge.reconcile_attempts + 1 },
        'reconcile: charge has no CheckoutRequestID (push timed out); awaiting a late callback or an operator',
      );
      continue;
    }

    // Network call, outside any transaction.
    let queryResult;
    try {
      queryResult = await opts.adapter.stkQuery(charge.checkout_request_id);
    } catch (err) {
      // Daraja unreachable or slow. Not an answer, so not a decision.
      summary.errors++;
      await bumpAttempt(opts.db, charge.id, now());
      opts.logger?.warn(
        {
          chargeId: charge.id,
          'mpesa.checkout_request_id': charge.checkout_request_id,
          uncertain: isUncertainOutcome(err),
          err: err instanceof Error ? err.message : String(err),
        },
        'reconcile: stkQuery failed; charge stays PENDING',
      );
      continue;
    }

    if (queryResult.status === 'pending') {
      summary.stillPending++;
      await bumpAttempt(opts.db, charge.id, now());
      if (charge.reconcile_attempts + 1 >= opts.maxAttempts) summary.needsAttention++;
      continue;
    }

    const { resultCode, resultDesc } = queryResult;
    const nowDate = now();

    const applied = await withTransaction(opts.db, async (tx) => {
      // Re-read inside the transaction: a callback may have resolved this
      // charge while we were on the network. The guard would catch it
      // anyway; re-reading means we also see an up-to-date hold_reason.
      const fresh = await tx.query<ChargeRow>('SELECT * FROM charges WHERE id = $1', [charge.id]);
      const current = fresh.rows[0];
      if (!current) return null;

      await tx.query(
        'UPDATE charges SET reconcile_attempts = reconcile_attempts + 1, last_reconciled_at = $2, updated_at = $2 WHERE id = $1',
        [charge.id, nowDate.toISOString()],
      );

      return applyChargeResolution(
        tx,
        current,
        resultCode === STK_RESULT.SUCCESS
          ? {
              outcome: 'paid',
              resultCode,
              resultDesc: resultDesc || DESC_BY_CODE[resultCode] || 'resolved by query',
              // stkQuery does not return a receipt; the callback would have.
              receipt: null,
              resolvedBy: 'query',
            }
          : {
              outcome: 'failed',
              resultCode,
              resultDesc: resultDesc || DESC_BY_CODE[resultCode] || 'declined',
              resolvedBy: 'query',
            },
        nowDate,
      );
    });

    if (applied?.applied) {
      if (applied.transition === 'PENDING->PAID') summary.resolvedPaid++;
      else summary.resolvedFailed++;
      opts.logger?.info(
        {
          chargeId: charge.id,
          saleId: charge.sale_id,
          'mpesa.checkout_request_id': charge.checkout_request_id,
          'mpesa.result_code': resultCode,
          transition: applied.transition,
        },
        'reconcile: resolved by stkQuery',
      );
    } else {
      summary.stillPending++;
    }
  }

  return summary;
}

async function bumpAttempt(db: Db, chargeId: string, now: Date): Promise<void> {
  await db.query(
    'UPDATE charges SET reconcile_attempts = reconcile_attempts + 1, last_reconciled_at = $2, updated_at = $2 WHERE id = $1',
    [chargeId, now.toISOString()],
  );
}

/**
 * Runs the reconciler on an interval under a Postgres advisory lock, so with
 * several ECS tasks only one reconciles at a time. Returns a stop function.
 */
export function startReconciler(
  opts: ReconcileOptions & { intervalMs: number },
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void withAdvisoryLock(opts.db, LOCK_KEY.RECONCILER, async () => runReconcileOnce(opts)).catch(
      (err: unknown) => opts.logger?.warn({ err: String(err) }, 'reconciler tick failed'),
    );
  }, opts.intervalMs);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
