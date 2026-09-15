/**
 * sale.paid is idempotent on sale_id: redelivery, duplication, and
 * out-of-order arrival all end in exactly one PAID transition.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './testDb.js';
import { seedTenant } from './fixtures.js';
import { createSale } from '../src/services/saleService.js';
import { FakeEventSource } from '../src/workers/fakeEventSource.js';
import { runOnce } from '../src/workers/salePaidConsumer.js';
import type { SalePaidEvent } from '@tillflow/shared/events';

async function makeSale(db: Awaited<ReturnType<typeof createTestDb>>['db']) {
  const { tenant, attendant, product } = await seedTenant(db);
  const { body: sale } = await createSale(
    db,
    tenant.id,
    attendant.id,
    [{ productId: product.id, quantity: 1 }],
    randomUUID(),
  );
  return { tenant, sale };
}

function paidEvent(saleId: string, tenantId: string, eventId: string): SalePaidEvent {
  return {
    eventType: 'sale.paid',
    eventId,
    occurredAt: new Date().toISOString(),
    data: { saleId, tenantId, chargeId: randomUUID(), amountMinor: 250, paidAt: new Date().toISOString() },
  };
}

test('redelivery of the SAME message id is a no-op', async () => {
  const { db } = createTestDb();
  const { tenant, sale } = await makeSale(db);
  const source = new FakeEventSource();
  const event = paidEvent(sale.id, tenant.id, randomUUID());

  // Same message id published twice, delivered in two separate batches —
  // simulates SQS at-least-once redelivery of one message.
  source.publish(event, 'msg-1');
  await runOnce({ db, source });
  source.publish(event, 'msg-1');
  await runOnce({ db, source });

  const result = await db.query<{ status: string }>('SELECT status FROM sales WHERE id = $1', [sale.id]);
  assert.equal(result.rows[0]?.status, 'PAID');

  const applied = await db.query('SELECT sale_id FROM sale_paid_events WHERE sale_id = $1', [sale.id]);
  assert.equal(applied.rowCount, 1, 'exactly one dedupe row regardless of redelivery count');
});

test('a DIFFERENT event for the same sale (duplicate publish) is also a no-op', async () => {
  const { db } = createTestDb();
  const { tenant, sale } = await makeSale(db);
  const source = new FakeEventSource();

  // Two distinct eventIds for the same saleId — e.g. Payments' own callback
  // dedupe failing to catch a double-publish. Idempotency here is on
  // sale_id, not eventId, so this must still collapse to one effect.
  source.publish(paidEvent(sale.id, tenant.id, randomUUID()));
  source.publish(paidEvent(sale.id, tenant.id, randomUUID()));
  await runOnce({ db, source });

  const result = await db.query<{ status: string; paid_at: string }>(
    'SELECT status, paid_at FROM sales WHERE id = $1',
    [sale.id],
  );
  assert.equal(result.rows[0]?.status, 'PAID');

  const applied = await db.query('SELECT sale_id FROM sale_paid_events WHERE sale_id = $1', [sale.id]);
  assert.equal(applied.rowCount, 1);
});

test('reordered delivery across two sales applies each exactly once, independently', async () => {
  const { db } = createTestDb();
  const a = await makeSale(db);
  const b = await makeSale(db);
  const source = new FakeEventSource();

  const eventA = paidEvent(a.sale.id, a.tenant.id, randomUUID());
  const eventB = paidEvent(b.sale.id, b.tenant.id, randomUUID());

  // B arrives, and is redelivered, BEFORE A's first delivery — order and
  // repetition must not matter.
  source.publish(eventB, 'msg-b');
  source.publish(eventB, 'msg-b');
  source.publish(eventA, 'msg-a');

  await runOnce({ db, source });

  const rows = await db.query<{ id: string; status: string }>(
    'SELECT id, status FROM sales WHERE id IN ($1, $2)',
    [a.sale.id, b.sale.id],
  );
  for (const row of rows.rows) {
    assert.equal(row.status, 'PAID');
  }

  const appliedA = await db.query('SELECT sale_id FROM sale_paid_events WHERE sale_id = $1', [a.sale.id]);
  const appliedB = await db.query('SELECT sale_id FROM sale_paid_events WHERE sale_id = $1', [b.sale.id]);
  assert.equal(appliedA.rowCount, 1);
  assert.equal(appliedB.rowCount, 1);
});

test('an unparseable/malformed message is left unacked, not silently dropped', async () => {
  const { db } = createTestDb();
  const source = new FakeEventSource();
  // @ts-expect-error deliberately malformed for the test
  source.publish({ eventType: 'not.sale.paid' }, 'bad-msg');

  const handled = await runOnce({ db, source });
  assert.equal(handled, 1, 'the batch was received');
  assert.equal(source.wasAcked('bad-msg'), false, 'but never acked, so a real queue would redeliver it');
});
