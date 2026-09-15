/**
 * The sale.paid consumer loop. One iteration: receive a batch, apply each
 * (idempotent — see applySalePaid), ack only what committed. A message that
 * throws is left un-acked, so SQS redelivers it (up to maxReceiveCount
 * before the DLQ, infra/data.tf) rather than being silently dropped.
 */
import type { Db } from '../db.js';
import type { EventSource, SalePaidEvent } from '@tillflow/shared/events';
import { isSalePaidEvent } from '@tillflow/shared/events';
import { applySalePaid } from '../services/saleService.js';

export interface ConsumerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface RunOnceOptions {
  db: Db;
  source: EventSource<SalePaidEvent>;
  logger?: ConsumerLogger;
  maxMessages?: number;
}

/** Processes one batch and returns how many messages were handled. Exposed separately from the run-forever loop so tests (and replay/reorder drills) can drive it deterministically, one batch at a time. */
export async function runOnce(opts: RunOnceOptions): Promise<number> {
  const { db, source, logger, maxMessages = 10 } = opts;
  const messages = await source.receive(maxMessages);

  for (const { id, body } of messages) {
    if (!isSalePaidEvent(body)) {
      logger?.error({ id, body }, 'sale.paid consumer: malformed event, leaving unacked');
      continue;
    }
    try {
      await applySalePaid(db, body);
      await source.ack(id);
      logger?.info(
        { id, saleId: body.data.saleId, eventId: body.eventId },
        'sale.paid applied',
      );
    } catch (err) {
      logger?.error(
        { id, saleId: body.data.saleId, err: err instanceof Error ? err.message : err },
        'sale.paid consumer: apply failed, leaving unacked for redelivery',
      );
    }
  }

  return messages.length;
}

/** Long-running loop for the real worker process (services/pos/src/worker.ts). Not used by tests, which call runOnce directly to control timing precisely. */
export async function runForever(opts: RunOnceOptions & { signal?: AbortSignal }): Promise<void> {
  while (!opts.signal?.aborted) {
    await runOnce(opts);
  }
}
