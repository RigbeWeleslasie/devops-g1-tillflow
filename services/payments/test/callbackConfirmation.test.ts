/**
 * G5: a success callback is a notification, not evidence.
 *
 * docs/threat-model.md carried this as an accepted residual risk, owned by
 * Payments and expiring at this gate: the callback endpoint is unauthenticated
 * by necessity — Safaricom cannot send our service token — and until now a
 * callback was accepted on two checks, a matching `CheckoutRequestID` and a
 * matching amount. Both are values an attacker can learn or guess, and getting
 * both right moved a sale to PAID and emitted `sale.paid` with no money behind
 * it.
 *
 * The fix is to ask Daraja over a channel the attacker does not control. The
 * callback now only tells us WHEN to ask; the provider's own records decide.
 *
 * Every test here drives the real `POST /callbacks/stk` route against the real
 * FakeAdapter, because the claim being tested is about a seam: it is not
 * enough that `confirmSuccess` returns the right verdict, the route has to act
 * on it before anything writes PAID.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MpesaTransportError, type MpesaAdapter } from '@tillflow/mpesa';
import { createHarness, chargeBody, countRows, SERVICE_TOKEN } from './harness.js';
import { buildApp } from '../src/app.js';
import { createTestDb } from './testDb.js';

/** KES 250 — ordinary money, the deterministic `success` scenario. */
const OK = 25_000;
/** KES 101 — the `cancelled` scenario: Daraja will report ResultCode 1032. */
const CANCELLED = 10_100;
/** KES 105 — `delayed_callback`: the customer does not act for another 61s. */
const DELAYED = 10_500;

/** A forged success callback for a reference the attacker has somehow learned. */
function forgedSuccess(reference: string, amountKes: number) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: 'forged',
        CheckoutRequestID: reference,
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: amountKes },
            { Name: 'MpesaReceiptNumber', Value: 'FORGED123' },
            { Name: 'TransactionDate', Value: 20260920103000 },
            { Name: 'PhoneNumber', Value: 254708374149 },
          ],
        },
      },
    },
  };
}

async function chargeRow(h: Awaited<ReturnType<typeof createHarness>>, reference: string) {
  const r = await h.db.query<{ id: string; status: string; hold_reason: string | null }>(
    'SELECT id, status, hold_reason FROM charges WHERE checkout_request_id = $1',
    [reference],
  );
  return r.rows[0]!;
}

describe('a forged success callback cannot move money', () => {
  test('Daraja says cancelled, the callback says paid — the sale does NOT go PAID', async () => {
    const h = await createHarness();
    // A real charge the customer will cancel. The attacker knows its
    // reference and its amount; that used to be enough.
    const created = await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: CANCELLED }) });
    const reference = created.json().checkoutRequestId as string;

    // Let the customer act (cancel), but do not deliver the real callback yet.
    h.advance(60_000);

    const res = await h.app.inject({
      method: 'POST',
      url: '/callbacks/stk',
      payload: forgedSuccess(reference, CANCELLED / 100),
    });
    // Daraja still gets its ack — the caller is the internet and learns nothing.
    assert.equal(res.statusCode, 200);

    const charge = await chargeRow(h, reference);
    assert.equal(charge.status, 'PENDING', 'not PAID: Daraja never said it was');
    assert.equal(
      await countRows(h.db, 'outbox_events'),
      0,
      'and no sale.paid was emitted — POS never hears about money that did not move',
    );
    await h.close();
  });

  test('the forgery changes NO state, so the real callback still settles the charge', async () => {
    const h = await createHarness();
    const created = await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: CANCELLED }) });
    const reference = created.json().checkoutRequestId as string;
    h.advance(60_000);

    await h.app.inject({ method: 'POST', url: '/callbacks/stk', payload: forgedSuccess(reference, CANCELLED / 100) });

    const held = await chargeRow(h, reference);
    assert.equal(
      held.hold_reason,
      null,
      'deliberately NOT held: freezing the charge would let anyone who can guess a ' +
        'reference deny service on that sale. A forged callback must be a no-op, ' +
        'not an incident for the person trying to pay.',
    );

    // Daraja's own callback arrives and is applied normally.
    await h.fake.deliverPending();
    const settled = await chargeRow(h, reference);
    assert.equal(settled.status, 'FAILED', 'cancelled by the customer, resolved correctly');
    await h.close();
  });

  test('racing the real callback fails too: Daraja has no answer yet, so neither do we', async () => {
    const h = await createHarness();
    // KES 105 — the `delayed_callback` scenario. The customer does not act for
    // another 61s, which is the window an attacker would actually race: forge
    // a success before the real result lands.
    const created = await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: DELAYED }) });
    const reference = created.json().checkoutRequestId as string;

    // No advance(): stkQuery reports "still processing", exactly as Daraja
    // does with 500.001.1001.
    await h.app.inject({ method: 'POST', url: '/callbacks/stk', payload: forgedSuccess(reference, DELAYED / 100) });

    assert.equal((await chargeRow(h, reference)).status, 'PENDING', 'not paid on an answer nobody gave');
    assert.equal(await countRows(h.db, 'outbox_events'), 0);

    // And when the real callback finally arrives, it settles normally.
    h.advance(61_000);
    await h.fake.deliverPending();
    assert.equal((await chargeRow(h, reference)).status, 'PAID', 'the honest payment is not collateral damage');
    await h.close();
  });
});

describe('the confirming query does not break, or slow, an honest payment', () => {
  test('a genuine success callback still settles the charge PAID', async () => {
    const h = await createHarness();
    await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: OK }) });
    await h.fake.deliverPending();

    const r = await h.db.query<{ status: string }>('SELECT status FROM charges');
    assert.equal(r.rows[0]?.status, 'PAID');
    assert.equal(await countRows(h.db, 'outbox_events'), 1, 'and sale.paid was emitted');
    await h.close();
  });

  test('an unmatched reference costs no Daraja call at all', async () => {
    // The endpoint is open to the internet, so anything it does on a caller's
    // behalf is an amplifier. A reference we never issued must not turn one
    // forged POST into one outbound Daraja request.
    const { db } = createTestDb();
    let queries = 0;
    const counting: MpesaAdapter = {
      stkPush: async () => {
        throw new Error('not used');
      },
      stkQuery: async () => {
        queries++;
        return { status: 'pending' };
      },
      b2cPayment: async () => {
        throw new Error('not used');
      },
    };
    const app = await buildApp({
      db,
      adapter: counting,
      serviceToken: SERVICE_TOKEN,
      callbackBaseUrl: 'http://x',
      logger: false,
    });

    for (let i = 0; i < 25; i++) {
      await app.inject({
        method: 'POST',
        url: '/callbacks/stk',
        payload: forgedSuccess(`ws_CO_guess_${i}`, 250),
      });
    }
    assert.equal(queries, 0, '25 forged callbacks, zero Daraja calls');
    await app.close();
  });

  test('a decline callback is applied without a confirming query — there is no PAID to guard', async () => {
    const h = await createHarness();
    let queries = 0;
    const original = h.fake.stkQuery.bind(h.fake);
    h.fake.stkQuery = async (id: string) => {
      queries++;
      return original(id);
    };

    await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: CANCELLED }) });
    h.advance(60_000);
    await h.fake.deliverPending();

    const r = await h.db.query<{ status: string }>('SELECT status FROM charges');
    assert.equal(r.rows[0]?.status, 'FAILED');
    assert.equal(queries, 0, 'a decline moves no money, so it needs no second opinion');
    await h.close();
  });
});

describe('when Daraja cannot be asked', () => {
  test('an unreachable query leaves the charge PENDING — never FAILED, never PAID (I5)', async () => {
    const { db } = createTestDb();
    let nowMs = Date.parse('2026-09-20T10:00:00Z');
    const unreachable: MpesaAdapter = {
      stkPush: async () => ({
        merchantRequestId: 'm-1',
        checkoutRequestId: 'ws_CO_1',
        responseCode: '0',
        responseDescription: 'Success',
        customerMessage: 'Success',
      }),
      stkQuery: async () => {
        throw new MpesaTransportError('ECONNRESET');
      },
      b2cPayment: async () => {
        throw new Error('not used');
      },
    };
    const app = await buildApp({
      db,
      adapter: unreachable,
      serviceToken: SERVICE_TOKEN,
      callbackBaseUrl: 'http://x',
      now: () => new Date(nowMs),
      logger: false,
    });
    await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { 'x-service-token': SERVICE_TOKEN },
      payload: chargeBody({ amountMinor: OK }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/callbacks/stk',
      payload: forgedSuccess('ws_CO_1', OK / 100),
    });
    assert.equal(res.statusCode, 200, 'Daraja is still acked; it must not retry forever');

    const r = await db.query<{ status: string; hold_reason: string | null }>('SELECT status, hold_reason FROM charges');
    assert.equal(r.rows[0]?.status, 'PENDING', 'a check we could not run is not a decline');
    assert.equal(r.rows[0]?.hold_reason, null, 'and not a hold — the reconciler owns this, as it does a timed-out push');
    assert.equal(await countRows(db, 'outbox_events'), 0);
    await app.close();
  });

  test('confirmBeforePaid:false restores the pre-G5 behaviour, for a Daraja query outage', async () => {
    const { db } = createTestDb();
    const noQuery: MpesaAdapter = {
      stkPush: async () => ({
        merchantRequestId: 'm-1',
        checkoutRequestId: 'ws_CO_1',
        responseCode: '0',
        responseDescription: 'Success',
        customerMessage: 'Success',
      }),
      stkQuery: async () => {
        throw new Error('stkQuery must not be called when confirmation is off');
      },
      b2cPayment: async () => {
        throw new Error('not used');
      },
    };
    const app = await buildApp({
      db,
      adapter: noQuery,
      serviceToken: SERVICE_TOKEN,
      callbackBaseUrl: 'http://x',
      confirmBeforePaid: false,
      logger: false,
    });
    await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { 'x-service-token': SERVICE_TOKEN },
      payload: chargeBody({ amountMinor: OK }),
    });

    await app.inject({ method: 'POST', url: '/callbacks/stk', payload: forgedSuccess('ws_CO_1', OK / 100) });

    const r = await db.query<{ status: string }>('SELECT status FROM charges');
    assert.equal(r.rows[0]?.status, 'PAID', 'the switch is a real switch — and this is what it costs');
    await app.close();
  });
});
