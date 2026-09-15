/**
 * Cross-service event contracts carried over SQS.
 *
 * These are the two seams docs say both tracks must agree on before either
 * starts. This file IS that agreement, in code both services import instead
 * of each hand-rolling their own shape.
 */

/**
 * Payments -> POS, over the `devops-g1-sale-events` queue.
 * Idempotent on `saleId` — the consumer must not apply this twice for the
 * same sale no matter how many times (or in what order) it's delivered.
 * This event is the ONLY thing that moves a sale to PAID; POS never sets
 * PAID itself.
 */
export interface SalePaidEvent {
  eventType: 'sale.paid';
  /** Unique per publish attempt; NOT the idempotency key (saleId is). Useful for tracing a specific delivery, not for dedup. */
  eventId: string;
  occurredAt: string; // ISO 8601
  data: {
    saleId: string;
    tenantId: string;
    chargeId: string;
    /** Integer minor units — see @tillflow/shared/money. Carried here so POS never has to ask Payments "how much did this actually settle for". */
    amountMinor: number;
    paidAt: string; // ISO 8601, when Daraja confirmed payment (not when the event was published)
  };
}

export function isSalePaidEvent(value: unknown): value is SalePaidEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['eventType'] !== 'sale.paid') return false;
  if (typeof v['eventId'] !== 'string' || typeof v['occurredAt'] !== 'string') return false;
  const data = v['data'];
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d['saleId'] === 'string' &&
    typeof d['tenantId'] === 'string' &&
    typeof d['chargeId'] === 'string' &&
    typeof d['amountMinor'] === 'number' &&
    typeof d['paidAt'] === 'string'
  );
}

/**
 * Pluggable event source, so a consumer can run against real SQS in prod and
 * an in-process fake in tests/local dev — the same pattern ADR 0005 uses for
 * the M-Pesa adapter. `ack` must be called only after the handler's DB write
 * commits; a crash between receive and ack redelivers, which is exactly what
 * idempotency-on-saleId is for.
 */
export interface EventSource<T> {
  /** Long-poll for the next batch. Empty array on timeout with nothing available. */
  receive(maxMessages: number): Promise<Array<{ id: string; body: T }>>;
  ack(id: string): Promise<void>;
}
