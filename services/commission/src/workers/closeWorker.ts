/**
 * The SQS consumer for the daily-close trigger.
 *
 * EventBridge Scheduler posts `{"type":"daily_close"}` to
 * devops-g1-commission-payout at 00:15 Africa/Nairobi (infra/data.tf). That
 * message carries no business day, so the worker derives it — the day that
 * has just ended. A message MAY name an explicit `businessDay`, which is
 * what makes a drill or a re-close reproducible.
 *
 * Delivery semantics, and why they are safe:
 *   - SQS is at-least-once. EventBridge's own retry policy (3 attempts) can
 *     also deliver the same trigger more than once. Both are fine: runClose
 *     is idempotent per (tenant, attendant, day), so a redelivered trigger
 *     re-runs the close and changes nothing.
 *   - The message is deleted only AFTER the close completes. A crash
 *     mid-close leaves it on the queue, it reappears after the visibility
 *     timeout, and the re-run picks up exactly the rows that were left
 *     COMPUTED.
 *   - A close that throws leaves the message un-acked too, so it retries
 *     and eventually lands in the DLQ rather than vanishing.
 */
import { trace } from '@opentelemetry/api';
import type { Db } from '../db.js';
import { LOCK_KEY, withAdvisoryLock } from '../db.js';
import type { PaymentsClient, PosReadClient } from '../types.js';
import { businessDayToClose, isBusinessDay } from '../services/businessDay.js';
import { runClose, type CloseResult } from '../services/closeService.js';

export interface TriggerMessage {
  id: string;
  body: unknown;
}

/** Pluggable queue, so tests drive the worker with no AWS at all. */
export interface TriggerSource {
  receive(maxMessages: number): Promise<TriggerMessage[]>;
  ack(id: string): Promise<void>;
}

export interface WorkerLogger {
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
}

export interface WorkerOptions {
  db: Db;
  pos: PosReadClient;
  payments: PaymentsClient;
  source: TriggerSource;
  now?: () => Date;
  logger?: WorkerLogger;
  /** Serialise closes across tasks. Disabled in tests, which use one db. */
  useAdvisoryLock?: boolean;
}

/**
 * Which day a trigger message asks us to close. An explicit businessDay
 * wins; otherwise the day that has just ended, in Nairobi.
 */
export function businessDayFor(body: unknown, at: Date): string {
  if (typeof body === 'object' && body !== null) {
    const explicit = (body as { businessDay?: unknown }).businessDay;
    if (isBusinessDay(explicit)) return explicit;
  }
  return businessDayToClose(at);
}

export interface BatchResult {
  received: number;
  closed: number;
  failed: number;
  results: CloseResult[];
}

/**
 * Process one batch. Separate from the forever-loop so tests (and the
 * replay drill) can drive it deterministically, one batch at a time.
 */
export async function runOnce(opts: WorkerOptions): Promise<BatchResult> {
  const now = opts.now ?? (() => new Date());
  const { source, logger } = opts;
  const messages = await source.receive(1);
  const out: BatchResult = { received: messages.length, closed: 0, failed: 0, results: [] };

  for (const message of messages) {
    const businessDay = businessDayFor(message.body, now());
    const span = trace.getActiveSpan();
    span?.setAttributes({
      'messaging.message_id': message.id,
      'commission.business_day': businessDay,
    });

    try {
      const run = async (): Promise<CloseResult> =>
        runClose(businessDay, {
          db: opts.db,
          pos: opts.pos,
          payments: opts.payments,
          now,
          ...(logger ? { logger } : {}),
        });

      // With several tasks, only one closes a given day at a time. If the
      // lock is held the message is left un-acked and redelivered — the
      // other task is already doing the work.
      const result = opts.useAdvisoryLock
        ? await withAdvisoryLock(opts.db, LOCK_KEY.DAILY_CLOSE, run)
        : await run();

      if (!result) {
        logger?.info(
          { 'messaging.message_id': message.id, businessDay },
          'close: another task holds the lock; leaving the trigger for redelivery',
        );
        continue;
      }

      out.closed++;
      out.results.push(result);

      // Ack only after the close committed. A crash before this point
      // redelivers the trigger, and the re-run is a no-op for rows already
      // written (I4).
      await source.ack(message.id);
      logger?.info(
        {
          'messaging.message_id': message.id,
          businessDay,
          created: result.ledgerRowsCreated,
          existing: result.ledgerRowsExisting,
          requested: result.payoutsRequested,
          uncertain: result.payoutsUncertain,
        },
        'close: trigger processed and acked',
      );
    } catch (err) {
      out.failed++;
      logger?.error(
        {
          'messaging.message_id': message.id,
          businessDay,
          err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
        'close: failed; trigger left un-acked for redelivery, then the DLQ',
      );
    }
  }

  return out;
}

/** Long-running loop for the real worker process. */
export async function runForever(opts: WorkerOptions & { signal?: AbortSignal }): Promise<void> {
  while (!opts.signal?.aborted) {
    try {
      await runOnce(opts);
    } catch (err) {
      // receive() itself failed (network, credentials). Do not spin.
      opts.logger?.error({ err: String(err) }, 'close worker: receive failed');
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}
