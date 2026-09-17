/**
 * G2's first named flow: **sale → STK callback → paid**, across the real POS
 * and Payments services with only Daraja faked.
 *
 * This is the test the gate actually asks for. Everything else in the repo
 * proves one service against its own idea of the contract; this proves the
 * contract itself.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack, seedTenantViaApi, type Stack } from './harness.js';

/** PR #9: POS now takes the customer's phone at payment time and forwards it. */
const CUSTOMER_MSISDN = '254708374149';

async function createSale(stack: Stack, ctx: Awaited<ReturnType<typeof seedTenantViaApi>>) {
  const res = await stack.pos.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${ctx.token}`, 'idempotency-key': randomUUID() },
    payload: { attendantId: ctx.attendantId, items: [{ productId: ctx.productId, quantity: 1 }] },
  });
  assert.equal(res.statusCode, 201, `sale creation failed: ${res.body}`);
  return res.json() as { id: string; status: string; totalMinor: number };
}

async function saleRow(stack: Stack, saleId: string) {
  const r = await stack.posDb.query('SELECT * FROM sales WHERE id = $1', [saleId]);
  return r.rows[0] as { status: string; charge_id: string | null; paid_at: string | null };
}

describe('sale → STK callback → paid', () => {
  test('a sale paid through the real Payments service ends PAID in POS', async () => {
    const stack = await startStack();
    const ctx = await seedTenantViaApi(stack);
    const sale = await createSale(stack, ctx);
    assert.equal(sale.status, 'UNPAID');

    // 1. The attendant takes payment. POS calls Payments for real.
    const pay = await stack.pos.inject({
      method: 'POST',
      url: `/sales/${sale.id}/pay`,
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { customerMsisdn: CUSTOMER_MSISDN },
    });
    // 202 is POS's honest answer for "charge outcome not yet known" — it is a
    // legitimate status, so assert on the SEAM rather than on this code.
    assert.ok([200, 202].includes(pay.statusCode), `pay failed: ${pay.statusCode} ${pay.body}`);

    // The seam itself: Payments must have ACCEPTED what POS sent. If this
    // fails, the two services disagree about the contract — which is
    // invisible to every other test in the repo, because they all fake it.
    const seamResponse = stack.seam.responses[0];
    assert.ok(seamResponse, 'POS never called Payments');
    assert.ok(
      seamResponse.status < 400,
      `Payments REJECTED the body POS sent (HTTP ${seamResponse.status}): ${seamResponse.body}\n` +
        `POS sent: ${JSON.stringify(stack.seam.requests[0])}`,
    );

    // 2. A charge exists on the Payments side, PENDING, with a provider id.
    const charge = await stack.paymentsDb.query('SELECT * FROM charges WHERE sale_id = $1', [sale.id]);
    assert.equal(charge.rowCount, 1, 'exactly one charge for the sale');
    assert.equal(charge.rows[0]!.status, 'PENDING');
    assert.ok(charge.rows[0]!.checkout_request_id, 'the STK push was acked');

    // 3. The customer pays. Daraja calls back, into the real callback route.
    assert.equal(await stack.deliverCallbacks(), 1);
    assert.equal((await stack.paymentsDb.query('SELECT status FROM charges WHERE sale_id = $1', [sale.id])).rows[0]!.status, 'PAID');

    // 4. sale.paid crosses the queue and POS applies it.
    const pumped = await stack.pump();
    assert.equal(pumped.published, 1, 'the outbox relayed exactly one event');

    const finalSale = await saleRow(stack, sale.id);
    assert.equal(finalSale.status, 'PAID', 'the sale is PAID in POS — the flow completed');
    assert.ok(finalSale.paid_at);
    assert.ok(finalSale.charge_id, 'and POS recorded which charge paid it');

    await stack.close();
  });

  test('a declined payment leaves the sale UNPAID, not PAID and not lost', async () => {
    const stack = await startStack();
    // KES 101 → the customer cancels at the prompt.
    const ctx = await seedTenantViaApi(stack, { unitPriceMinor: 10_100 });
    const sale = await createSale(stack, ctx);

    await stack.pos.inject({
      method: 'POST',
      url: `/sales/${sale.id}/pay`,
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { customerMsisdn: CUSTOMER_MSISDN },
    });
    await stack.deliverCallbacks();

    const charge = await stack.paymentsDb.query('SELECT status FROM charges WHERE sale_id = $1', [sale.id]);
    assert.equal(charge.rows[0]!.status, 'FAILED', 'a genuine decline is terminal');

    const pumped = await stack.pump();
    assert.equal(pumped.published, 0, 'a decline produces no sale.paid');
    assert.equal((await saleRow(stack, sale.id)).status, 'UNPAID', 'the sale can be retried');

    await stack.close();
  });

  test('an uncertain payment (timeout) leaves the sale UNPAID and the charge PENDING — never FAILED', async () => {
    const stack = await startStack();
    // KES 103 → the push times out; we never learn the CheckoutRequestID.
    const ctx = await seedTenantViaApi(stack, { unitPriceMinor: 10_300 });
    const sale = await createSale(stack, ctx);

    const pay = await stack.pos.inject({
      method: 'POST',
      url: `/sales/${sale.id}/pay`,
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { customerMsisdn: CUSTOMER_MSISDN },
    });
    assert.ok([200, 202].includes(pay.statusCode), `${pay.statusCode} ${pay.body}`);
    assert.notEqual(pay.json().charge.status, 'FAILED', 'a timeout is never reported as a decline');

    const charge = await stack.paymentsDb.query('SELECT * FROM charges WHERE sale_id = $1', [sale.id]);
    assert.equal(charge.rows[0]!.status, 'PENDING');
    assert.equal(charge.rows[0]!.checkout_request_id, null);
    assert.equal((await saleRow(stack, sale.id)).status, 'UNPAID');

    // The customer did pay; the late callback adopts the charge.
    const [ref] = stack.fake.unresolvedTimeouts();
    stack.fake.resolveTimeout(ref!, 'success');
    stack.advance(60_000);
    await stack.deliverCallbacks();
    await stack.pump();

    assert.equal((await saleRow(stack, sale.id)).status, 'PAID', 'resolved without a second charge');
    assert.equal(
      (await stack.paymentsDb.query('SELECT count(*)::int AS n FROM charges')).rows[0]!.n,
      1,
      'still exactly one charge',
    );

    await stack.close();
  });

  test('paying twice creates one charge and one sale.paid, across both services', async () => {
    const stack = await startStack();
    const ctx = await seedTenantViaApi(stack);
    const sale = await createSale(stack, ctx);
    const auth = { authorization: `Bearer ${ctx.token}` };

    await stack.pos.inject({ method: 'POST', url: `/sales/${sale.id}/pay`, headers: auth, payload: { customerMsisdn: CUSTOMER_MSISDN } });
    await stack.pos.inject({ method: 'POST', url: `/sales/${sale.id}/pay`, headers: auth, payload: { customerMsisdn: CUSTOMER_MSISDN } });

    assert.equal(
      (await stack.paymentsDb.query('SELECT count(*)::int AS n FROM charges')).rows[0]!.n,
      1,
      'I2 holds across the real seam',
    );

    // Deliver the callback, replay it, and pump twice: still one effect.
    await stack.deliverCallbacks();
    await stack.fake.redeliver(stack.fake.deliveredCallbacks()[0]!);
    await stack.pump();
    await stack.pump();

    assert.equal(
      (await stack.paymentsDb.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0]!.n,
      1,
      'I3 holds: one ledger effect',
    );
    assert.equal(
      (await stack.posDb.query('SELECT count(*)::int AS n FROM sale_paid_events')).rows[0]!.n,
      1,
      'and POS applied it once',
    );
    assert.equal((await saleRow(stack, sale.id)).status, 'PAID');

    await stack.close();
  });
});
