/**
 * The transactional outbox for sale.paid.
 *
 * `writeSalePaidOutbox` is called inside the transaction that makes a charge
 * PAID, so there is never a window where the charge is PAID and the event
 * was not recorded. UNIQUE(event_type, aggregate_id) means a second write
 * for the same charge is impossible however many callbacks arrive — that
 * constraint IS "one ledger effect" (I3).
 *
 * `relayOnce` then publishes unpublished rows to SQS and marks them. It is
 * at-least-once on purpose: a crash between SendMessage and the UPDATE
 * redelivers, and POS's consumer is idempotent on saleId, which is exactly
 * what that idempotency is for. Never at-most-once — losing a sale.paid
 * would leave a paid sale showing UNPAID forever.
 */
import { randomUUID } from 'node:crypto';
import type { SalePaidEvent } from '@tillflow/shared/events';
import type { Db, Tx } from '../db.js';
import type { ChargeRow } from '../types.js';

export async function writeSalePaidOutbox(
  tx: Tx,
  charge: ChargeRow,
  paidAt: Date,
  now: Date,
): Promise<string> {
  const outboxId = randomUUID();
  const event: SalePaidEvent = {
    eventType: 'sale.paid',
    eventId: outboxId,
    occurredAt: now.toISOString(),
    data: {
      saleId: charge.sale_id,
      tenantId: charge.tenant_id,
      chargeId: charge.id,
      amountMinor: charge.amount_minor,
      paidAt: paidAt.toISOString(),
    },
  };
  await tx.query(
    `INSERT INTO outbox_events (id, event_type, aggregate_id, payload, created_at)
     VALUES ($1, 'sale.paid', $2, $3, $4)`,
    [outboxId, charge.id, JSON.stringify(event), now.toISOString()],
  );
  return outboxId;
}

/** Publishes one event to the queue. Implemented by SQS in prod, a fake in tests. */
export interface EventPublisher {
  publish(event: SalePaidEvent): Promise<void>;
}

export interface RelayOptions {
  db: Db;
  publisher: EventPublisher;
  batchSize?: number;
  now?: () => Date;
}

export interface RelayResult {
  published: number;
  failed: number;
}

interface OutboxRow {
  id: string;
  payload: string | SalePaidEvent;
  publish_attempts: number;
}

export async function relayOnce(opts: RelayOptions): Promise<RelayResult> {
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 25;

  const res = await opts.db.query<OutboxRow>(
    `SELECT id, payload, publish_attempts FROM outbox_events
     WHERE published_at IS NULL
     ORDER BY created_at
     LIMIT ${batchSize}`,
  );

  let published = 0;
  let failed = 0;

  for (const row of res.rows) {
    const event = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as SalePaidEvent;
    try {
      await opts.publisher.publish(event);
      // Marked only after the send returns. A crash before this redelivers
      // the event — at-least-once, which POS's consumer absorbs.
      await opts.db.query('UPDATE outbox_events SET published_at = $2 WHERE id = $1', [
        row.id,
        now().toISOString(),
      ]);
      published++;
    } catch (err) {
      failed++;
      await opts.db.query(
        'UPDATE outbox_events SET publish_attempts = publish_attempts + 1, last_error = $2 WHERE id = $1',
        [row.id, err instanceof Error ? `${err.name}: ${err.message}` : String(err)],
      );
    }
  }

  return { published, failed };
}
