/**
 * The schema's own guarantees, proven at the database layer before any
 * application code depends on them. Each of these is a line of defence that
 * holds even if a handler has a bug: the invariant is in the constraint.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './testDb.js';
import { isUniqueViolation, didInsert } from '../src/db.js';

const T = randomUUID();

async function insertCharge(db: ReturnType<typeof createTestDb>['db'], saleId: string, amount = 10_000) {
  return db.query(
    `INSERT INTO charges (id, sale_id, tenant_id, amount_minor, till, customer_msisdn, status)
     VALUES ($1, $2, $3, $4, '174379', '254708374149', 'PENDING')`,
    [randomUUID(), saleId, T, amount],
  );
}

describe('migrations load into pg-mem', () => {
  test('all six tables exist', async () => {
    const { db } = createTestDb();
    for (const table of ['charges', 'callback_events', 'outbox_events', 'payout_ledger', 'payouts', 'close_runs']) {
      await db.query(`SELECT 1 FROM ${table} LIMIT 0`);
    }
  });
});

describe('I2 — one charge per sale, at the constraint level', () => {
  test('a second charge for the same sale_id is a unique violation', async () => {
    const { db } = createTestDb();
    const saleId = randomUUID();
    await insertCharge(db, saleId);
    await assert.rejects(insertCharge(db, saleId), (err) => isUniqueViolation(err));
  });
});

describe('money constraints — whole shillings only where M-Pesa is involved', () => {
  test('a charge with cents is refused', async () => {
    const { db } = createTestDb();
    await assert.rejects(insertCharge(db, randomUUID(), 10_050), /check|constraint/i);
  });

  test('a zero-amount charge is refused', async () => {
    const { db } = createTestDb();
    await assert.rejects(insertCharge(db, randomUUID(), 0), /check|constraint/i);
  });

  test('payout_ledger records exact commission, whole-shilling payout, and the remainder', async () => {
    const { db } = createTestDb();
    // Commission KES 5.05 -> payout KES 5, remainder 5 cents.
    await db.query(
      `INSERT INTO payout_ledger (id, tenant_id, attendant_id, business_day, amount_minor, payout_minor, remainder_minor,
                                  rate_bps, msisdn, sale_count, sale_total_minor, status)
       VALUES ($1, $2, $3, '2026-09-14', 505, 500, 5, 500, '254700000000', 1, 10100, 'COMPUTED')`,
      [randomUUID(), T, randomUUID()],
    );
    // A payout_minor with cents is refused.
    await assert.rejects(
      db.query(
        `INSERT INTO payout_ledger (id, tenant_id, attendant_id, business_day, amount_minor, payout_minor, remainder_minor,
                                    rate_bps, msisdn, sale_count, sale_total_minor, status)
         VALUES ($1, $2, $3, '2026-09-14', 505, 505, 0, 500, '254700000000', 1, 10100, 'COMPUTED')`,
        [randomUUID(), T, randomUUID()],
      ),
      /check|constraint/i,
    );
  });
});

describe('I3 — one ledger effect per charge, at the constraint level', () => {
  test('a second sale.paid outbox row for the same charge is a unique violation', async () => {
    const { db } = createTestDb();
    const chargeId = randomUUID();
    const insert = () =>
      db.query(
        `INSERT INTO outbox_events (id, event_type, aggregate_id, payload) VALUES ($1, 'sale.paid', $2, '{}')`,
        [randomUUID(), chargeId],
      );
    await insert();
    await assert.rejects(insert(), (err) => isUniqueViolation(err));
  });

  test('callback dedupe: an identical redelivery collides and bumps duplicate_count (ON CONFLICT DO UPDATE)', async () => {
    const { db } = createTestDb();
    const upsert = () =>
      db.query<{ duplicate_count: number }>(
        `INSERT INTO callback_events (id, kind, reference, result_code, checksum, matched, applied, body)
         VALUES ($1, 'stk', 'ws_CO_1', 0, 'abc', true, true, '{}')
         ON CONFLICT (kind, reference, result_code, checksum)
         DO UPDATE SET duplicate_count = callback_events.duplicate_count + 1
         RETURNING duplicate_count`,
        [randomUUID()],
      );
    const first = await upsert();
    assert.equal(first.rows[0]?.duplicate_count, 0, 'first delivery: fresh row');
    const second = await upsert();
    assert.equal(second.rows[0]?.duplicate_count, 1, 'redelivery: same row, counted');
    const third = await upsert();
    assert.equal(third.rows[0]?.duplicate_count, 2);

    const rows = await db.query('SELECT count(*)::int AS n FROM callback_events');
    assert.equal(rows.rows[0]?.n, 1, 'exactly one row regardless of redelivery count');
  });
});

describe('I4 — one payout per (tenant, attendant, day), at the constraint level', () => {
  test('ledger: the same (tenant, attendant, business_day) twice is a unique violation; ON CONFLICT DO NOTHING inserts nothing', async () => {
    const { db } = createTestDb();
    const attendantId = randomUUID();
    const insert = (id: string, onConflict: string) =>
      db.query<{ id: string }>(
        `INSERT INTO payout_ledger (id, tenant_id, attendant_id, business_day, amount_minor, payout_minor, remainder_minor,
                                    rate_bps, msisdn, sale_count, sale_total_minor, status)
         VALUES ($1, $2, $3, '2026-09-14', 500, 500, 0, 500, '254700000000', 1, 10000, 'COMPUTED') ${onConflict}
         RETURNING id`,
        [id, T, attendantId],
      );
    const firstId = randomUUID();
    assert.equal(didInsert(await insert(firstId, ''), firstId), true);
    await assert.rejects(insert(randomUUID(), ''), (err) => isUniqueViolation(err));

    // The replay path the commission worker uses. didInsert(), not rowCount:
    // pg-mem returns the EXISTING row here where Postgres returns none.
    const replayId = randomUUID();
    const replay = await insert(replayId, 'ON CONFLICT (tenant_id, attendant_id, business_day) DO NOTHING');
    assert.equal(didInsert(replay, replayId), false, 're-running the close is a no-op');

    const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM payout_ledger');
    assert.equal(count.rows[0]?.n, 1);
  });

  test('payouts: a second payout for the same ledger row is a unique violation', async () => {
    const { db } = createTestDb();
    const ledgerId = randomUUID();
    await db.query(
      `INSERT INTO payout_ledger (id, tenant_id, attendant_id, business_day, amount_minor, payout_minor, remainder_minor,
                                  rate_bps, msisdn, sale_count, sale_total_minor, status)
       VALUES ($1, $2, $3, '2026-09-14', 500, 500, 0, 500, '254700000000', 1, 10000, 'COMPUTED')`,
      [ledgerId, T, randomUUID()],
    );
    const insertPayout = () =>
      db.query(
        `INSERT INTO payouts (id, ledger_id, tenant_id, amount_minor, msisdn, status, originator_conversation_id)
         VALUES ($1, $2, $3, 500, '254700000000', 'PENDING', $4)`,
        [randomUUID(), ledgerId, T, randomUUID()],
      );
    await insertPayout();
    await assert.rejects(insertPayout(), (err) => isUniqueViolation(err));
  });
});

describe('state enums are enforced', () => {
  test('a charge cannot be inserted in an unknown status', async () => {
    const { db } = createTestDb();
    await assert.rejects(
      db.query(
        `INSERT INTO charges (id, sale_id, tenant_id, amount_minor, till, customer_msisdn, status)
         VALUES ($1, $2, $3, 10000, '174379', '254708374149', 'MAYBE')`,
        [randomUUID(), randomUUID(), T],
      ),
      /check|constraint/i,
    );
  });
});
