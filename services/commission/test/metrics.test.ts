/**
 * The Commission SLI metrics (G3), asserted by running the real close against
 * the real OpenTelemetry SDK.
 *
 * The Commission SLO is unusual in that its headline number is not a
 * percentage: "duplicate disbursement = 0" is a hard invariant, and a
 * dashboard that cannot show it holding is not evidence of anything. So the
 * load-bearing assertions here are about the GAP between two series — a
 * replayed close increments `replayed` and leaves `requested` untouched — and
 * about the one gauge the budget panel reads.
 *
 * The on-time gauge gets the most attention because it is the easiest thing in
 * G3 to get quietly wrong: it is a wall-clock judgement, it is written once per
 * run, and a replay drill evaluated against today's clock would flip it red for
 * reasons that have nothing to do with reliability.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './testDb.js';
import { FakePosClient, FakePaymentsClient, tenantWith } from './fakes.js';
import { runClose } from '../src/services/closeService.js';
import { collectMetrics, drainMetrics, shutdownMetrics } from './metricsHarness.js';

const PAYOUTS = 'commission_payout_total';
const RUN_SECONDS = 'commission_run_duration_seconds';
const ON_TIME = 'commission_run_completed_before_0630';

const DAY = '2026-09-14';
/** 00:15 EAT on the 15th — the scheduler's slot, comfortably before 06:30. */
const ON_SCHEDULE = new Date('2026-09-15T00:15:00+03:00');
/** 07:00 EAT on the 15th — half an hour past the deadline. */
const LATE = new Date('2026-09-15T07:00:00+03:00');

function harness(tenants = [tenantWith({ saleTotals: [100_000] })], now = ON_SCHEDULE) {
  const { db } = createTestDb();
  const pos = new FakePosClient();
  pos.setDay(DAY, tenants);
  const payments = new FakePaymentsClient(db);
  return { db, pos, payments, close: () => runClose(DAY, { db, pos, payments, now: () => now }) };
}

beforeEach(drainMetrics);
after(shutdownMetrics);

describe('the instruments exist under the names docs/slo-error-budgets.md alarms on', () => {
  test('one close emits all three, spelled exactly as the SLO spells them', async () => {
    const h = harness();
    await h.close();

    const m = await collectMetrics();
    assert.deepEqual(m.names(), [PAYOUTS, ON_TIME, RUN_SECONDS]);
    assert.equal(m.descriptor(PAYOUTS)?.name, 'commission_payout_total');
    assert.equal(m.descriptor(RUN_SECONDS)?.name, 'commission_run_duration_seconds');
    assert.equal(m.descriptor(ON_TIME)?.name, 'commission_run_completed_before_0630');
    assert.equal(m.descriptor(RUN_SECONDS)?.unit, 's');
  });
});

describe('commission_payout_total', () => {
  test('a payable attendant is one `computed` and one `requested`', async () => {
    const h = harness();
    await h.close();

    const m = await collectMetrics();
    assert.equal(m.counter(PAYOUTS, { state: 'computed' }), 1);
    assert.equal(m.counter(PAYOUTS, { state: 'requested' }), 1);
    assert.equal(m.counter(PAYOUTS, { state: 'replayed' }), 0);
  });

  test('a replay is `replayed` and requests nothing — I4, as the gap between two series', async () => {
    const h = harness();
    await h.close();
    await drainMetrics(); // the first close; this test is about the second

    await h.close();

    const m = await collectMetrics();
    assert.equal(m.counter(PAYOUTS, { state: 'replayed' }), 1, 'the row was already there');
    assert.equal(m.counter(PAYOUTS, { state: 'computed' }), 0, 'nothing recomputed');
    assert.equal(
      m.counter(PAYOUTS, { state: 'requested' }),
      0,
      'and nothing re-requested — this zero is what "duplicate disbursement = 0" looks like on a panel',
    );
    assert.equal(h.payments.disbursements.size, 1, 'and it is true of the money, not only of the metric');
  });

  test('sub-shilling commission is `skipped_zero`, not an error', async () => {
    // KES 6 at 5% = 30 cents. M-Pesa cannot send that.
    const h = harness([tenantWith({ saleTotals: [600] })]);
    await h.close();

    const m = await collectMetrics();
    assert.equal(m.counter(PAYOUTS, { state: 'skipped_zero' }), 1);
    assert.equal(m.counter(PAYOUTS, { state: 'requested' }), 0);
  });

  test('an attendant with no MSISDN is `skipped_no_msisdn` — a different problem, needing a different human', async () => {
    const h = harness([tenantWith({ saleTotals: [100_000], msisdn: null })]);
    await h.close();

    const m = await collectMetrics();
    assert.equal(m.counter(PAYOUTS, { state: 'skipped_no_msisdn' }), 1);
    assert.equal(
      m.counter(PAYOUTS, { state: 'skipped_zero' }),
      0,
      'lumping these together would hide real money that nobody can send behind rounding dust',
    );
  });

  test('a lost payout request is `uncertain`, never counted as a failure', async () => {
    const h = harness();
    h.payments.failNextAsUnknown = 1;
    await h.close();

    const m = await collectMetrics();
    assert.equal(m.counter(PAYOUTS, { state: 'uncertain' }), 1);
    assert.equal(m.counter(PAYOUTS, { state: 'rejected' }), 0);
    assert.equal(m.counter(PAYOUTS, { state: 'requested' }), 0);
  });

  test('a payout Payments refuses is `rejected`', async () => {
    const h = harness();
    h.payments.rejectNext = 1;
    await h.close();

    const m = await collectMetrics();
    assert.equal(m.counter(PAYOUTS, { state: 'rejected' }), 1);
    assert.equal(m.counter(PAYOUTS, { state: 'uncertain' }), 0);
  });
});

describe('commission_run_duration_seconds', () => {
  test('a completed run records one observation under `completed`', async () => {
    const h = harness();
    await h.close();

    const m = await collectMetrics();
    const point = m.histogram(RUN_SECONDS, { status: 'completed' });
    assert.ok(point);
    assert.equal(point.count, 1);
    assert.ok(
      point.sum !== undefined && point.sum > 0,
      'a real elapsed time. The close runs on a FROZEN clock here, so a duration taken from ' +
        'the injected now() would be exactly 0 — which is why durations use performance.now().',
    );
  });

  test('a run that throws is timed too, under `failed`', async () => {
    const h = harness();
    h.pos.failWith = new Error('POS unreachable');
    await assert.rejects(h.close());

    const m = await collectMetrics();
    assert.equal(m.histogram(RUN_SECONDS, { status: 'failed' })?.count, 1);
    assert.equal(
      m.histogram(RUN_SECONDS, { status: 'completed' }),
      undefined,
      'a close that never finished must not be counted as one that did',
    );
  });
});

describe('commission_run_completed_before_0630 — the budget panel the gate asks for', () => {
  test('the 00:15 EAT slot is on time: 1', async () => {
    const h = harness();
    await h.close();

    assert.equal((await collectMetrics()).gauge(ON_TIME), 1);
  });

  test('07:00 EAT is late: 0', async () => {
    const h = harness([tenantWith({ saleTotals: [100_000] })], LATE);
    await h.close();

    assert.equal((await collectMetrics()).gauge(ON_TIME), 0, '06:30 is the deadline, and it is past');
  });

  test('a run that failed is 0, whatever the clock said', async () => {
    const h = harness();
    h.pos.failWith = new Error('POS unreachable');
    await assert.rejects(h.close());

    assert.equal((await collectMetrics()).gauge(ON_TIME), 0);
  });

  test('an empty day still answers — a day with no sales was closed, and on time', async () => {
    const h = harness([]);
    await h.close();

    const m = await collectMetrics();
    assert.equal(m.gauge(ON_TIME), 1);
    assert.deepEqual(m.points(PAYOUTS), [], 'no attendants, so no payout series at all');
  });

  test('a REPLAY does not touch the gauge, so a drill cannot turn the SLO red', async () => {
    // The real close, on schedule.
    const { db } = createTestDb();
    const pos = new FakePosClient();
    pos.setDay(DAY, [tenantWith({ saleTotals: [100_000] })]);
    const payments = new FakePaymentsClient(db);
    await runClose(DAY, { db, pos, payments, now: () => ON_SCHEDULE });
    await drainMetrics();

    // Now re-close the same day weeks later, as the runbook's replay drill
    // does. Every row is already there.
    const replayedAt = new Date('2026-10-01T11:00:00+03:00');
    const result = await runClose(DAY, { db, pos, payments, now: () => replayedAt });
    assert.equal(result.ledgerRowsCreated, 0);
    assert.equal(result.ledgerRowsExisting, 1);

    const m = await collectMetrics();
    assert.equal(
      m.gauge(ON_TIME),
      undefined,
      'the drill is trivially "after 06:30 on 2026-09-15"; writing 0 here would report a ' +
        'reliability failure that did not happen, and that is how people learn to distrust the panel',
    );
    assert.equal(m.counter(PAYOUTS, { state: 'replayed' }), 1, 'the replay is still visible — as a replay');
    assert.equal(m.histogram(RUN_SECONDS, { status: 'completed' })?.count, 1, 'and still timed');
  });
});
