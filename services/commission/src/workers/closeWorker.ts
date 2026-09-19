/**
 * The SQS consumer for the daily-close trigger.
 *
 * EventBridge Scheduler posts the trigger to devops-g1-commission-payout at
 * 00:15 Africa/Nairobi (infra/data.tf). The message carries `scheduledFor`
 * — the instant the schedule was due — and the worker closes the day that had
 * ended by THAT instant. A message MAY also name an explicit `businessDay`,
 * which is what makes a drill or a re-close reproducible.
 *
 * Deriving the day from the scheduled time rather than from the wall clock is
 * load-bearing, not tidiness. See `resolveBusinessDay`.
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

/** Where the day we are closing came from. Logged, so a close can be audited. */
export type BusinessDaySource = 'explicit' | 'scheduled' | 'processing-time';

/**
 * A `scheduledFor` we are willing to trust: parseable, and not in the future.
 *
 * The future check is the one that protects money. A scheduled time ahead of
 * now would name a business day that has NOT finished, and closing a day still
 * in progress pays commission on a partial day — then the ledger's
 * UNIQUE(tenant, attendant, business_day) makes that partial figure permanent,
 * so the rest of that day's sales are never paid. Falling back to the wall
 * clock is strictly safer than trusting a clock we cannot explain.
 */
function trustedScheduledTime(value: unknown, at: Date): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (ms > at.getTime()) return null;
  return new Date(ms);
}

/**
 * Which day a trigger asks us to close, and how we decided.
 *
 * Order: an explicit `businessDay` (a drill or a re-close) wins; then the day
 * that had ended as of `scheduledFor`; then, only if neither is usable, the day
 * that has ended as of now.
 *
 * That middle step exists because of a real incident. The scheduler's message
 * used to carry no time at all, so the day came from the wall clock at
 * PROCESSING time. `commission` sat at desiredCount 0 for four days while the
 * deploy gate rolled itself back, four triggers queued up, and every one of
 * them would have resolved to the same day the moment the worker started — one
 * real close and three idempotent no-op replays, with the three older business
 * days never closed and nothing anywhere looking wrong, because a replay is
 * indistinguishable from success.
 *
 * The trigger has to carry the instant it was due. Anything derived from when
 * the worker happens to get around to it is a guess that gets worse the longer
 * a backlog sits — which is exactly when it matters.
 */
export function resolveBusinessDay(
  body: unknown,
  at: Date,
): { businessDay: string; source: BusinessDaySource } {
  if (typeof body === 'object' && body !== null) {
    const b = body as { businessDay?: unknown; scheduledFor?: unknown };
    if (isBusinessDay(b.businessDay)) return { businessDay: b.businessDay, source: 'explicit' };

    const scheduled = trustedScheduledTime(b.scheduledFor, at);
    if (scheduled) {
      return { businessDay: businessDayToClose(scheduled), source: 'scheduled' };
    }
  }
  return { businessDay: businessDayToClose(at), source: 'processing-time' };
}

/** The day alone, for callers that do not care how it was decided. */
export function businessDayFor(body: unknown, at: Date): string {
  return resolveBusinessDay(body, at).businessDay;
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
    // `daySource`, not `source`: `source` is already the TriggerSource in this
    // scope, and shadowing it here would turn `source.ack()` below into a call
    // on a string.
    const { businessDay, source: daySource } = resolveBusinessDay(message.body, now());
    const span = trace.getActiveSpan();
    span?.setAttributes({
      'messaging.message_id': message.id,
      'commission.business_day': businessDay,
      'commission.business_day_source': daySource,
    });

    if (daySource === 'processing-time') {
      // The trigger told us nothing about when it was due, so the day came
      // from the wall clock. Correct for a trigger consumed promptly, and
      // wrong for every one that has been sitting on the queue — see
      // resolveBusinessDay. Warn rather than fail: closing today's day is
      // still better than closing none, and the operator needs to know the
      // close may have skipped days.
      logger?.warn(
        { 'messaging.message_id': message.id, businessDay },
        'close: trigger carried no scheduledFor; day derived from the wall clock. ' +
          'A backlogged trigger will close the wrong day — check infra/data.tf.',
      );
    }

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
          businessDaySource: daySource,
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
