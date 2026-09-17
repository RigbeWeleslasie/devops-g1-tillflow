/**
 * G2's second named flow: **close → commission → B2C**, across the real POS,
 * Payments and Commission services with only Daraja faked.
 *
 * The first flow (`saleToPaid.test.ts`) proved the POS→Payments seam. This one
 * proves the other two seams the gate names, and for the same reason: every
 * unit suite fakes the boundary it depends on. `close.test.ts` drives the close
 * through `FakePosClient` + `FakePaymentsClient`; `clients.test.ts` drives the
 * real HTTP clients through a stubbed `fetchImpl`; `payouts.test.ts` drives the
 * payout state machine from Payments' own side. Each passes against its OWN
 * idea of the contract, so a disagreement between them is invisible — which is
 * precisely how the `tenantId`/`customerMsisdn` gap survived on flow 1.
 *
 * Here nothing between the three services is faked:
 *
 *   Commission --HTTP--> POS  /internal/daily-close   (real route, real client)
 *              --HTTP--> Payments /payouts           (real route, real client)
 *                             |
 *                             v
 *                        FakeAdapter  B2C
 *
 * Commission's own `HttpPosClient` and `HttpPaymentsClient` run unmodified;
 * only their socket is replaced (see `injectFetch` in the harness).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack, seedTenantViaApi, type Stack } from './harness.js';

const CUSTOMER_MSISDN = '254708374149';
/** The harness clock is 2026-09-16T10:00Z — 13:00 in Nairobi, so the 16th. */
const BUSINESS_DAY = '2026-09-16';

/** Drive a sale all the way to PAID in POS, through both services for real. */
async function paidSale(stack: Stack, ctx: Awaited<ReturnType<typeof seedTenantViaApi>>) {
  const created = await stack.pos.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${ctx.token}`, 'idempotency-key': randomUUID() },
    payload: { attendantId: ctx.attendantId, items: [{ productId: ctx.productId, quantity: 1 }] },
  });
  assert.equal(created.statusCode, 201, `sale creation failed: ${created.body}`);
  const sale = created.json() as { id: string; totalMinor: number };

  await stack.pos.inject({
    method: 'POST',
    url: `/sales/${sale.id}/pay`,
    headers: { authorization: `Bearer ${ctx.token}` },
    payload: { customerMsisdn: CUSTOMER_MSISDN },
  });
  await stack.deliverCallbacks();
  await stack.pump();

  const row = await stack.posDb.query('SELECT status FROM sales WHERE id = $1', [sale.id]);
  assert.equal(row.rows[0]!.status, 'PAID', 'the sale must be PAID before it can be closed');
  return sale;
}

const ledgerRows = (stack: Stack) =>
  stack.paymentsDb.query('SELECT * FROM payout_ledger ORDER BY computed_at');
const payoutRows = (stack: Stack) => stack.paymentsDb.query('SELECT * FROM payouts');

describe('close → commission → B2C', () => {
  test('a day of paid sales closes into one ledger row, one B2C, and lands PAID', async () => {
    const stack = await startStack();
    const ctx = await seedTenantViaApi(stack); // KES 250 a unit, 5%
    await paidSale(stack, ctx);

    // 1. Commission runs its close. Both hops are real HTTP handlers.
    const result = await stack.runDailyClose(BUSINESS_DAY);
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.tenantsProcessed, 1);
    assert.equal(result.attendantsProcessed, 1);
    assert.equal(result.ledgerRowsCreated, 1);
    assert.equal(result.payoutsRequested, 1, 'the payout was actually requested of Payments');
    assert.equal(result.payoutsUncertain, 0);

    // 2. The ledger row Payments wrote is the one Commission computed — this is
    //    the seam. KES 250 at 5% is KES 12.50, and M-Pesa cannot send cents:
    //    the payout is floored to KES 12 and the 50c remainder is banked, not
    //    rounded away and not silently paid.
    const ledger = (await ledgerRows(stack)).rows[0]! as Record<string, unknown>;
    assert.equal(ledger['rate_bps'], 500, 'the rate in force at the sale, snapshotted');
    assert.equal(ledger['sale_total_minor'], 25_000);
    assert.equal(ledger['amount_minor'], 1_250);
    assert.equal(ledger['payout_minor'], 1_200, 'floored to whole shillings');
    assert.equal(ledger['remainder_minor'], 50, 'and the remainder is carried, not lost');
    assert.equal(
      Number(ledger['amount_minor']),
      Number(ledger['payout_minor']) + Number(ledger['remainder_minor']),
      'money is conserved: nothing is created or destroyed by the rounding',
    );
    assert.equal(ledger['status'], 'REQUESTED');

    // 3. Exactly one disbursement, to the attendant's own MSISDN — which came
    //    from the attendant record via POS, never from a request body (A7).
    const payouts = await payoutRows(stack);
    assert.equal(payouts.rowCount, 1);
    assert.equal(payouts.rows[0]!.status, 'PENDING');
    assert.equal(payouts.rows[0]!.amount_minor, 1_200);
    assert.equal(payouts.rows[0]!.msisdn, '254700000000');
    assert.equal(payouts.rows[0]!.ledger_id, ledger['id']);

    // 4. Daraja calls back on the B2C result.
    const pending = stack.fake.peekPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.kind, 'b2c', 'a B2C result callback, not an STK one');
    assert.equal(await stack.deliverCallbacks(), 1);

    assert.equal((await payoutRows(stack)).rows[0]!.status, 'PAID');
    assert.equal((await ledgerRows(stack)).rows[0]!.status, 'PAID', 'the ledger followed');

    await stack.close();
  });

  test('re-running the close pays nobody a second time (I4)', async () => {
    const stack = await startStack();
    const ctx = await seedTenantViaApi(stack);
    await paidSale(stack, ctx);

    await stack.runDailyClose(BUSINESS_DAY);
    await stack.deliverCallbacks();

    // The drill from evidence/payments-integrity: run the same day again.
    const second = await stack.runDailyClose(BUSINESS_DAY);
    assert.equal(second.status, 'COMPLETED', 'a replay is a no-op, not an error');
    assert.equal(second.ledgerRowsCreated, 0, 'nothing recomputed');
    assert.equal(second.ledgerRowsExisting, 1);
    assert.equal(second.payoutsRequested, 0, 'and nothing re-requested');

    assert.equal((await ledgerRows(stack)).rowCount, 1, 'still one ledger row');
    const payouts = await payoutRows(stack);
    assert.equal(payouts.rowCount, 1, 'still one payout — duplicate disbursement = 0');
    assert.equal(payouts.rows[0]!.status, 'PAID');
    assert.equal(
      stack.fake.peekPending().length,
      0,
      'and no second B2C was ever handed to Daraja',
    );

    await stack.close();
  });

  test('a failed disbursement is recorded as FAILED and not silently retried', async () => {
    const stack = await startStack();
    // KES 2040 at 5% = KES 102.00 — the `insufficient_funds` scenario, which
    // here means the BUSINESS float cannot cover the payout.
    const ctx = await seedTenantViaApi(stack, { unitPriceMinor: 204_000 });
    await paidSale(stack, ctx);

    const result = await stack.runDailyClose(BUSINESS_DAY);
    assert.equal(result.payoutsRequested, 1);
    assert.equal((await ledgerRows(stack)).rows[0]!['payout_minor'], 10_200);

    await stack.deliverCallbacks();

    const payouts = await payoutRows(stack);
    assert.equal(payouts.rowCount, 1);
    assert.equal(payouts.rows[0]!.status, 'FAILED', 'a definite decline is terminal');
    assert.equal((await ledgerRows(stack)).rows[0]!['status'], 'FAILED', 'the ledger followed');

    // Re-closing must not quietly re-attempt it. A failed payout is an
    // operator decision (docs/runbook.md), not something a scheduled job
    // retries on its own — that is how a double payment happens.
    const second = await stack.runDailyClose(BUSINESS_DAY);
    assert.equal(second.ledgerRowsCreated, 0);
    assert.equal(second.payoutsRequested, 0, 'the close does not retry a failed disbursement');
    assert.equal((await payoutRows(stack)).rowCount, 1, 'and no second payout row appeared');

    await stack.close();
  });

  test('commission below one shilling pays nothing and banks the remainder', async () => {
    const stack = await startStack();
    // KES 6 at 5% = 30 cents. M-Pesa cannot send that, and rounding it UP would
    // pay money nobody earned.
    const ctx = await seedTenantViaApi(stack, { unitPriceMinor: 600 });
    await paidSale(stack, ctx);

    const result = await stack.runDailyClose(BUSINESS_DAY);
    assert.equal(result.ledgerRowsCreated, 1, 'the day is still recorded');
    assert.equal(result.payoutsRequested, 0);
    assert.equal(result.payoutsSkippedZero, 1);

    const ledger = (await ledgerRows(stack)).rows[0]! as Record<string, unknown>;
    assert.equal(ledger['amount_minor'], 30);
    assert.equal(ledger['payout_minor'], 0);
    assert.equal(ledger['remainder_minor'], 30, 'carried, so it is auditable rather than lost');
    assert.equal(ledger['status'], 'SKIPPED');

    assert.equal((await payoutRows(stack)).rowCount, 0, 'no payout row at all');
    assert.equal(stack.fake.peekPending().length, 0, 'and Daraja was never called');

    await stack.close();
  });

  test('a day with no paid sales closes cleanly and moves no money', async () => {
    const stack = await startStack();
    await seedTenantViaApi(stack);

    const result = await stack.runDailyClose(BUSINESS_DAY);
    assert.equal(result.status, 'COMPLETED', 'an empty day is not a failure');
    assert.equal(result.tenantsProcessed, 0);
    assert.equal(result.ledgerRowsCreated, 0);
    assert.equal(result.payoutsRequested, 0);
    assert.equal((await payoutRows(stack)).rowCount, 0);
    assert.equal(stack.fake.peekPending().length, 0);

    await stack.close();
  });
});
