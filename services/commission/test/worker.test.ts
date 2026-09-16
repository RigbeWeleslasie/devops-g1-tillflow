/**
 * The SQS trigger path: which day a trigger closes, and what happens when a
 * trigger is redelivered, arrives twice, or the close fails mid-way.
 *
 * EventBridge retries up to 3 times and SQS is at-least-once, so a duplicate
 * trigger is not an edge case — it is expected traffic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './testDb.js';
import { FakePosClient, FakePaymentsClient, tenantWith } from './fakes.js';
import { FakeTriggerSource } from '../src/workers/sqsTriggerSource.js';
import { businessDayFor, runOnce } from '../src/workers/closeWorker.js';
import { businessDayToClose } from '../src/services/businessDay.js';
import type { Db } from '../src/db.js';

const DAY = '2026-09-14';
/** 00:15 EAT on the 15th — when the scheduler fires. */
const TRIGGER_TIME = new Date('2026-09-15T00:15:00+03:00');

function harness(tenants = [tenantWith({ saleTotals: [100_000] })]) {
  const { db } = createTestDb();
  const pos = new FakePosClient();
  pos.setDay(DAY, tenants);
  const payments = new FakePaymentsClient(db);
  const source = new FakeTriggerSource();
  return {
    db,
    pos,
    payments,
    source,
    tick: () => runOnce({ db, pos, payments, source, now: () => TRIGGER_TIME }),
  };
}

async function ledgerCount(db: Db): Promise<number> {
  const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM payout_ledger');
  return r.rows[0]?.n ?? 0;
}

describe('which day a trigger closes', () => {
  test('the scheduler message carries no day, so the worker closes the day that just ENDED', () => {
    // EventBridge fires at 00:15 EAT on the 15th to settle the 14th.
    assert.equal(businessDayFor({ type: 'daily_close' }, TRIGGER_TIME), '2026-09-14');
    assert.equal(businessDayToClose(TRIGGER_TIME), '2026-09-14');
  });

  test('an explicit businessDay wins — this is what makes a re-close reproducible', () => {
    assert.equal(businessDayFor({ type: 'daily_close', businessDay: '2026-08-01' }, TRIGGER_TIME), '2026-08-01');
  });

  test('a malformed or impossible businessDay falls back rather than closing nothing', () => {
    for (const bad of [{ businessDay: '2026-02-31' }, { businessDay: 'yesterday' }, { businessDay: 42 }, {}, null, 'x']) {
      assert.equal(businessDayFor(bad, TRIGGER_TIME), '2026-09-14', JSON.stringify(bad));
    }
  });

  test('the fallback respects the Nairobi day, not the UTC one', () => {
    // 23:30 UTC on the 14th is 02:30 EAT on the 15th — the day to close is
    // still the 14th. A UTC-based worker would close the 13th.
    assert.equal(businessDayFor({}, new Date('2026-09-14T23:30:00Z')), '2026-09-14');
  });
});

describe('processing a trigger', () => {
  test('runs the close and acks only after it commits', async () => {
    const h = harness();
    h.source.publish({ type: 'daily_close', source: 'eventbridge-scheduler' }, 'trigger-1');

    const batch = await h.tick();

    assert.equal(batch.received, 1);
    assert.equal(batch.closed, 1);
    assert.equal(batch.results[0]?.businessDay, DAY);
    assert.equal(batch.results[0]?.ledgerRowsCreated, 1);
    assert.ok(h.source.acked.has('trigger-1'), 'acked after the close committed');
    assert.equal(await ledgerCount(h.db), 1);
    await h.db.query('SELECT 1');
  });

  test('a redelivered trigger re-runs the close and changes nothing', async () => {
    const h = harness();
    h.source.publish({ type: 'daily_close' }, 'trigger-1');
    await h.tick();

    // SQS at-least-once: the same message id arrives again.
    h.source.publish({ type: 'daily_close' }, 'trigger-1');
    const second = await h.tick();

    assert.equal(second.closed, 1, 'the close ran again');
    assert.equal(second.results[0]?.ledgerRowsCreated, 0, 'and created nothing');
    assert.equal(second.results[0]?.ledgerRowsExisting, 1);
    assert.equal(await ledgerCount(h.db), 1);
    assert.equal(h.payments.disbursements.size, 1, 'duplicate disbursement = 0');
  });

  test("EventBridge's own retries — three distinct trigger ids for one day — still pay once", async () => {
    const h = harness();
    for (const id of ['attempt-1', 'attempt-2', 'attempt-3']) {
      h.source.publish({ type: 'daily_close' }, id);
    }
    await h.tick();
    await h.tick();
    await h.tick();

    assert.equal(await ledgerCount(h.db), 1);
    assert.equal(h.payments.disbursements.size, 1);
    assert.equal(h.source.acked.size, 3, 'each trigger is acked; none is left to redeliver');
  });

  test('a failing close leaves the trigger UN-acked, so SQS redelivers it and it can reach the DLQ', async () => {
    const h = harness();
    h.pos.failWith = new Error('POS unreachable');
    h.source.publish({ type: 'daily_close' }, 'trigger-1');

    const batch = await h.tick();

    assert.equal(batch.failed, 1);
    assert.equal(batch.closed, 0);
    assert.equal(h.source.acked.has('trigger-1'), false, 'never acked — the work is not lost');
    assert.equal(await ledgerCount(h.db), 0);

    // Once POS recovers, the redelivered trigger completes the close.
    h.pos.failWith = null;
    h.source.publish({ type: 'daily_close' }, 'trigger-1');
    const retry = await h.tick();
    assert.equal(retry.closed, 1);
    assert.equal(await ledgerCount(h.db), 1);
  });

  test('an empty queue is a no-op, not an error', async () => {
    const h = harness();
    const batch = await h.tick();
    assert.deepEqual({ received: batch.received, closed: batch.closed, failed: batch.failed }, {
      received: 0,
      closed: 0,
      failed: 0,
    });
  });

  test('a drill trigger for an explicit past day closes that day, leaving others alone', async () => {
    const h = harness();
    h.pos.setDay('2026-08-01', [tenantWith({ saleTotals: [50_000] })]);

    h.source.publish({ type: 'daily_close' }, 'today');
    await h.tick();
    h.source.publish({ type: 'daily_close', businessDay: '2026-08-01' }, 'drill');
    await h.tick();

    const rows = await h.db.query<{ business_day: string | Date }>('SELECT business_day FROM payout_ledger');
    const days = rows.rows
      .map((r) => (r.business_day instanceof Date ? r.business_day.toISOString().slice(0, 10) : String(r.business_day).slice(0, 10)))
      .sort();
    assert.deepEqual(days, ['2026-08-01', '2026-09-14']);
    assert.equal(h.payments.disbursements.size, 2, 'two different days, two payouts — not a duplicate');
  });
});
