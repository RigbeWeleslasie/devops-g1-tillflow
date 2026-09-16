/**
 * The daily close — I4: one payout per (tenant, attendant, business day),
 * duplicate disbursement = 0.
 *
 * This file is the replay drill, executed: re-run the close, redeliver the
 * trigger, crash mid-run, and prove every path converges on exactly one
 * payment per ledger row.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './testDb.js';
import { FakePosClient, FakePaymentsClient, tenantWith } from './fakes.js';
import { computeCommission, runClose, InvalidBusinessDayError } from '../src/services/closeService.js';
import type { Db } from '../src/db.js';

const DAY = '2026-09-14';
const NOW = new Date('2026-09-15T00:15:00+03:00');

function harness(tenants = [tenantWith({ saleTotals: [100_000, 100_000] })]) {
  const { db } = createTestDb();
  const pos = new FakePosClient();
  pos.setDay(DAY, tenants);
  const payments = new FakePaymentsClient(db);
  return { db, pos, payments, close: () => runClose(DAY, { db, pos, payments, now: () => NOW }) };
}

async function ledger(db: Db) {
  const r = await db.query('SELECT * FROM payout_ledger ORDER BY computed_at');
  return r.rows;
}

/** A DATE column arrives as a Date from pg and pg-mem, as a string from some drivers. */
function businessDayOf(row: { business_day: string | Date }): string {
  return row.business_day instanceof Date
    ? row.business_day.toISOString().slice(0, 10)
    : String(row.business_day).slice(0, 10);
}

describe('computeCommission — the rounding rule, in one place', () => {
  test('floors PER SALE then sums, which is not the same as flooring the total', () => {
    const c = computeCommission({
      attendantId: 'a',
      msisdn: '254700000000',
      rateBps: 500,
      sales: [10_050, 10_050, 10_050].map((totalMinor) => ({ saleId: randomUUID(), totalMinor })),
    });
    assert.equal(c.amountMinor, 1506, 'per-sale: 502 + 502 + 502');
    assert.notEqual(c.amountMinor, 1507, 'flooring the 30150 total would give 1507');
    assert.equal(c.saleCount, 3);
    assert.equal(c.saleTotalMinor, 30_150);
  });

  test('splits the exact commission into a whole-shilling payout and a visible remainder', () => {
    // KES 1000.00 at 5% = KES 50.00 exactly -> no remainder.
    const exact = computeCommission({
      attendantId: 'a',
      msisdn: '254700000000',
      rateBps: 500,
      sales: [{ saleId: 'x', totalMinor: 100_000 }],
    });
    assert.equal(exact.amountMinor, 5_000);
    assert.equal(exact.payoutMinor, 5_000);
    assert.equal(exact.remainderMinor, 0);

    // KES 101.00 at 5% = KES 5.05 -> pay KES 5, 5 cents stay with the tenant.
    const partial = computeCommission({
      attendantId: 'a',
      msisdn: '254700000000',
      rateBps: 500,
      sales: [{ saleId: 'x', totalMinor: 10_100 }],
    });
    assert.equal(partial.amountMinor, 505);
    assert.equal(partial.payoutMinor, 500);
    assert.equal(partial.remainderMinor, 5);
    assert.equal(partial.payoutMinor + partial.remainderMinor, partial.amountMinor, 'nothing is lost');
  });

  test('a commission under one shilling pays nothing but is still computed exactly', () => {
    const c = computeCommission({
      attendantId: 'a',
      msisdn: '254700000000',
      rateBps: 100, // 1%
      sales: [{ saleId: 'x', totalMinor: 5_000 }], // KES 50 -> KES 0.50
    });
    assert.equal(c.amountMinor, 50);
    assert.equal(c.payoutMinor, 0);
    assert.equal(c.remainderMinor, 50);
  });

  test('a zero rate is zero commission, not an error', () => {
    const c = computeCommission({
      attendantId: 'a',
      msisdn: '254700000000',
      rateBps: 0,
      sales: [{ saleId: 'x', totalMinor: 100_000 }],
    });
    assert.equal(c.amountMinor, 0);
    assert.equal(c.payoutMinor, 0);
  });
});

describe('a first close', () => {
  test('writes one ledger row per attendant and requests one payout', async () => {
    const h = harness();
    const result = await h.close();

    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.ledgerRowsCreated, 1);
    assert.equal(result.ledgerRowsExisting, 0);
    assert.equal(result.payoutsRequested, 1);

    const rows = await ledger(h.db);
    assert.equal(rows.length, 1);
    assert.equal(businessDayOf(rows[0]!), DAY);
    assert.equal(rows[0]!.amount_minor, 10_000, 'two KES 1000 sales at 5%');
    assert.equal(rows[0]!.payout_minor, 10_000);
    assert.equal(rows[0]!.sale_count, 2);
    assert.equal(rows[0]!.status, 'REQUESTED', 'the fake Payments accepted it');
    assert.equal(h.payments.disbursements.size, 1);
  });

  test('snapshots the rate and MSISDN at compute time, so a later change cannot rewrite it', async () => {
    const h = harness([tenantWith({ saleTotals: [100_000], rateBps: 750, msisdn: '254711111111' })]);
    await h.close();

    const rows = await ledger(h.db);
    assert.equal(rows[0]!.rate_bps, 750);
    assert.equal(rows[0]!.msisdn, '254711111111');

    // The owner now changes both. A re-run must not touch the existing row.
    h.pos.setDay(DAY, [
      tenantWith({
        tenantId: rows[0]!.tenant_id,
        attendantId: rows[0]!.attendant_id,
        saleTotals: [100_000],
        rateBps: 2_000,
        msisdn: '254799999999',
      }),
    ]);
    await h.close();

    const after = await ledger(h.db);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.rate_bps, 750, 'the snapshot stands');
    assert.equal(after[0]!.msisdn, '254711111111');
  });

  test('records a SKIPPED row for an attendant who earned less than a shilling', async () => {
    const h = harness([tenantWith({ saleTotals: [5_000], rateBps: 100 })]); // KES 0.50
    const result = await h.close();

    assert.equal(result.payoutsSkippedZero, 1);
    assert.equal(result.payoutsRequested, 0);
    const rows = await ledger(h.db);
    assert.equal(rows[0]!.status, 'SKIPPED', 'visible in the ledger, not silently omitted');
    assert.equal(rows[0]!.amount_minor, 50);
    assert.equal(h.payments.calls.length, 0, 'nothing was sent');
  });

  test('handles several tenants and attendants independently', async () => {
    const multi = [
      tenantWith({ saleTotals: [100_000] }),
      {
        tenantId: randomUUID(),
        attendants: [
          { attendantId: randomUUID(), msisdn: '254700000001', rateBps: 500, sales: [{ saleId: randomUUID(), totalMinor: 200_000 }] },
          { attendantId: randomUUID(), msisdn: '254700000002', rateBps: 1_000, sales: [{ saleId: randomUUID(), totalMinor: 200_000 }] },
        ],
      },
    ];
    const h = harness(multi);
    const result = await h.close();

    assert.equal(result.tenantsProcessed, 2);
    assert.equal(result.attendantsProcessed, 3);
    assert.equal(result.ledgerRowsCreated, 3);
    assert.equal(h.payments.disbursements.size, 3);
    const amounts = (await ledger(h.db)).map((r) => r.amount_minor).sort((a, b) => a - b);
    assert.deepEqual(amounts, [5_000, 10_000, 20_000]);
  });
});

describe('I4 — the replay drill', () => {
  test('re-running the same close is a no-op: no new row, no second payment', async () => {
    const h = harness();
    const first = await h.close();
    const second = await h.close();

    assert.equal(first.ledgerRowsCreated, 1);
    assert.equal(second.ledgerRowsCreated, 0, 'nothing created');
    assert.equal(second.ledgerRowsExisting, 1);
    assert.equal(second.payoutsRequested, 0, 'the row is REQUESTED, not COMPUTED — nothing to ask for');

    assert.equal((await ledger(h.db)).length, 1);
    assert.equal(h.payments.disbursements.size, 1, 'duplicate disbursement = 0');
  });

  test('running the close ten times still produces one row and one payment', async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) await h.close();

    assert.equal((await ledger(h.db)).length, 1);
    assert.equal(h.payments.disbursements.size, 1);
    const runs = await h.db.query('SELECT count(*)::int AS n FROM close_runs');
    assert.equal(runs.rows[0]?.n, 10, 'every run is recorded, even though nine did nothing');
  });

  test('concurrent closes for the same day converge on one row and one payment', async () => {
    const h = harness();
    await Promise.all([h.close(), h.close(), h.close()]);

    assert.equal((await ledger(h.db)).length, 1);
    assert.equal(h.payments.disbursements.size, 1);
  });

  test('a crash between computing the row and requesting the payout is recovered by the next run', async () => {
    const h = harness();
    // The payout request fails at the HTTP level — Payments may or may not
    // have it. The row must stay COMPUTED, never FAILED.
    h.payments.failNextAsUnknown = 1;
    const first = await h.close();

    assert.equal(first.ledgerRowsCreated, 1);
    assert.equal(first.payoutsUncertain, 1);
    assert.equal(first.payoutsRequested, 0);
    assert.equal((await ledger(h.db))[0]!.status, 'COMPUTED', 'still owed, and visibly so');

    // The next run picks it up and completes it.
    const second = await h.close();
    assert.equal(second.ledgerRowsCreated, 0, 'no second ledger row');
    assert.equal(second.payoutsRequested, 1, 'but the payout is requested now');
    assert.equal(h.payments.disbursements.size, 1, 'still exactly one payment');
  });

  test('a payout Payments rejects leaves the row COMPUTED for a human, and sends nothing', async () => {
    const h = harness();
    h.payments.rejectNext = 1;
    const result = await h.close();

    assert.equal(result.payoutsUncertain, 1);
    assert.equal((await ledger(h.db))[0]!.status, 'COMPUTED');
    assert.equal(h.payments.disbursements.size, 0);
  });

  test('the ledger unique constraint holds even if the worker tries to insert twice directly', async () => {
    const h = harness();
    await h.close();
    const row = (await ledger(h.db))[0]!;

    await assert.rejects(
      h.db.query(
        `INSERT INTO payout_ledger (id, tenant_id, attendant_id, business_day, amount_minor, payout_minor,
                                    remainder_minor, rate_bps, msisdn, sale_count, sale_total_minor, status)
         VALUES ($1, $2, $3, $4, 1, 0, 1, 500, '254700000000', 1, 100, 'COMPUTED')`,
        [randomUUID(), row.tenant_id, row.attendant_id, DAY],
      ),
      (err: unknown) => (err as { code?: string }).code === '23505',
      'the database refuses a second row for the same tenant/attendant/day',
    );
  });
});

describe('a close for a different day is a different close', () => {
  test('the same attendant gets one row per business day', async () => {
    const { db } = createTestDb();
    const pos = new FakePosClient();
    const payments = new FakePaymentsClient(db);
    const tenant = tenantWith({ saleTotals: [100_000] });
    pos.setDay('2026-09-14', [tenant]);
    pos.setDay('2026-09-15', [tenant]);

    await runClose('2026-09-14', { db, pos, payments, now: () => NOW });
    await runClose('2026-09-15', { db, pos, payments, now: () => NOW });

    const rows = await ledger(db);
    assert.equal(rows.length, 2);
    assert.equal(payments.disbursements.size, 2, 'two days, two payments — that is not a duplicate');
  });
});

describe('failure handling', () => {
  test('an unreachable POS fails the run loudly and records it, without writing a partial ledger', async () => {
    const { db } = createTestDb();
    const pos = new FakePosClient();
    pos.failWith = new Error('POS unreachable');
    const payments = new FakePaymentsClient();

    await assert.rejects(runClose(DAY, { db, pos, payments, now: () => NOW }), /POS unreachable/);

    assert.equal((await ledger(db)).length, 0);
    const runs = await db.query('SELECT status, error FROM close_runs');
    assert.equal(runs.rows[0]?.status, 'FAILED');
    assert.match(runs.rows[0]?.error, /POS unreachable/);
  });

  test('an impossible or malformed business day is refused before anything is written', async () => {
    const { db } = createTestDb();
    const pos = new FakePosClient();
    const payments = new FakePaymentsClient();
    for (const day of ['2026-02-31', '14-09-2026', 'yesterday', '']) {
      await assert.rejects(runClose(day, { db, pos, payments }), InvalidBusinessDayError, day);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM close_runs')).rows[0]?.n, 0);
    assert.deepEqual(pos.calls, [], 'POS was never even asked');
  });
});

describe('the close run record', () => {
  test('records what happened, so a replay is provable from the database alone', async () => {
    const h = harness();
    await h.close();
    await h.close();

    const runs = await h.db.query('SELECT * FROM close_runs ORDER BY started_at');
    assert.equal(runs.rowCount, 2);
    assert.equal(runs.rows[0]?.ledger_rows_created, 1);
    assert.equal(runs.rows[0]?.ledger_rows_existing, 0);
    assert.equal(runs.rows[1]?.ledger_rows_created, 0);
    assert.equal(runs.rows[1]?.ledger_rows_existing, 1, 'the replay is visible as a fact, not an inference');
    for (const r of runs.rows) {
      assert.equal(r.status, 'COMPLETED');
      assert.ok(r.finished_at);
    }
  });
});

describe('review finding — an attendant with no MSISDN is ledgered, not dropped', () => {
  test('their sales still appear, with a SKIPPED row and nothing sent', async () => {
    const h = harness([tenantWith({ saleTotals: [100_000], msisdn: null })]);
    const result = await h.close();

    assert.equal(result.attendantsProcessed, 1, 'the attendant was processed, not skipped over');
    assert.equal(result.ledgerRowsCreated, 1, 'and their day is on the ledger');

    const rows = await ledger(h.db);
    assert.equal(rows[0]!.status, 'SKIPPED', 'unpayable, but visible');
    assert.equal(rows[0]!.amount_minor, 5_000, 'the commission they earned is still recorded');
    assert.equal(rows[0]!.sale_count, 1, 'and the sales behind it are not lost');
    assert.equal(h.payments.calls.length, 0, 'nothing was sent — there is nowhere to send it');
    await h.close;
  });

  test('a re-run once the MSISDN is fixed does NOT retroactively pay the old day', async () => {
    const h = harness([tenantWith({ saleTotals: [100_000], msisdn: null })]);
    await h.close();
    const row = (await ledger(h.db))[0]!;

    // The owner adds the phone number and the close is re-run.
    h.pos.setDay(DAY, [
      tenantWith({
        tenantId: row.tenant_id,
        attendantId: row.attendant_id,
        saleTotals: [100_000],
        msisdn: '254733333333',
      }),
    ]);
    const second = await h.close();

    // I4 still governs: the row for that (tenant, attendant, day) exists, so
    // nothing is recomputed. Paying it now is an operator decision with a
    // record, not something a re-run does silently.
    assert.equal(second.ledgerRowsCreated, 0);
    assert.equal((await ledger(h.db))[0]!.status, 'SKIPPED', 'still SKIPPED — the snapshot stands');
    assert.equal(h.payments.disbursements.size, 0);
    await h.close;
  });
});
