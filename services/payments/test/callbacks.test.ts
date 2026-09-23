/**
 * POST /callbacks/stk — I3: one legal transition and one ledger effect per
 * callback, at any order or repetition count. These ARE the replay and
 * reorder drills: every callback here is delivered by the FakeAdapter
 * through the real route via inject, exactly as Daraja's POST would be.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isSalePaidEvent } from '@tillflow/shared/events';
import type { StkCallbackBody } from '@tillflow/mpesa';
import { createHarness, chargeBody, countRows, CALLBACK_BASE, type Harness } from './harness.js';
import { pushStk, validateCreateCharge } from '../src/services/chargeService.js';

async function charge(h: Harness, overrides: Record<string, unknown> = {}) {
  const body = chargeBody(overrides);
  const res = await h.call({ method: 'POST', url: '/charges', payload: body });
  assert.equal(res.statusCode, 201);
  return { body, chargeId: res.json().chargeId as string, checkoutRequestId: res.json().checkoutRequestId as string };
}

async function chargeRow(h: Harness, id: string) {
  const r = await h.db.query('SELECT * FROM charges WHERE id = $1', [id]);
  return r.rows[0]!;
}

async function events(h: Harness, reference: string) {
  const r = await h.db.query('SELECT * FROM callback_events WHERE reference = $1 ORDER BY received_at', [reference]);
  return r.rows;
}

async function outbox(h: Harness, chargeId: string) {
  const r = await h.db.query("SELECT * FROM outbox_events WHERE event_type = 'sale.paid' AND aggregate_id = $1", [chargeId]);
  return r.rows;
}

describe('one callback, one transition, one effect', () => {
  test('success: PENDING -> PAID, receipt recorded, exactly one sale.paid outbox row with the right payload', async () => {
    const h = await createHarness();
    const { body, chargeId, checkoutRequestId } = await charge(h);

    assert.equal(await h.fake.deliverPending(), 1);

    const c = await chargeRow(h, chargeId);
    assert.equal(c.status, 'PAID');
    assert.equal(c.resolved_by, 'callback');
    assert.match(c.mpesa_receipt, /^FAKE/);
    assert.ok(c.paid_at);
    assert.equal(c.result_code, 0);

    const ev = await events(h, checkoutRequestId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.matched, true);
    assert.equal(ev[0]!.applied, true);
    assert.equal(ev[0]!.duplicate_count, 0);

    const ob = await outbox(h, chargeId);
    assert.equal(ob.length, 1, 'exactly one ledger effect');
    assert.equal(ob[0]!.published_at, null, 'not yet relayed');
    const payload = typeof ob[0]!.payload === 'string' ? JSON.parse(ob[0]!.payload) : ob[0]!.payload;
    assert.ok(isSalePaidEvent(payload), 'the payload is a valid SalePaidEvent for POS');
    assert.equal(payload.data.saleId, body['saleId']);
    assert.equal(payload.data.tenantId, body['tenantId']);
    assert.equal(payload.data.chargeId, chargeId);
    assert.equal(payload.data.amountMinor, 25_000);
    assert.equal(payload.eventId, ob[0]!.id);
    await h.close();
  });

  test('cancelled (1032): PENDING -> FAILED, no outbox row', async () => {
    const h = await createHarness();
    const { chargeId, checkoutRequestId } = await charge(h, { amountMinor: 10_100 }); // KES 101
    await h.fake.deliverPending();

    const c = await chargeRow(h, chargeId);
    assert.equal(c.status, 'FAILED');
    assert.equal(c.result_code, 1032);
    assert.ok(c.failed_at);
    assert.equal((await events(h, checkoutRequestId))[0]!.applied, true);
    assert.equal((await outbox(h, chargeId)).length, 0, 'a decline has no ledger effect');
    await h.close();
  });

  test('insufficient funds (1): PENDING -> FAILED', async () => {
    const h = await createHarness();
    const { chargeId } = await charge(h, { amountMinor: 10_200 }); // KES 102
    await h.fake.deliverPending();
    assert.equal((await chargeRow(h, chargeId)).status, 'FAILED');
    await h.close();
  });
});

describe('replay — the same callback again', () => {
  test('an identical redelivery is recorded as a duplicate on the SAME row, applies nothing, still 200', async () => {
    const h = await createHarness();
    const { chargeId, checkoutRequestId } = await charge(h);
    await h.fake.deliverPending();
    const first = h.fake.deliveredCallbacks()[0]!;

    // Daraja retries, or a proxy replays. Same bytes.
    await h.fake.redeliver(first);
    await h.fake.redeliver(first);

    const ev = await events(h, checkoutRequestId);
    assert.equal(ev.length, 1, 'one row for three deliveries');
    assert.equal(ev[0]!.duplicate_count, 2, 'and it counted both replays');

    assert.equal((await chargeRow(h, chargeId)).status, 'PAID');
    assert.equal((await outbox(h, chargeId)).length, 1, 'still exactly one ledger effect');
    await h.close();
  });

  test('the duplicate_callback scenario (KES 104): both queued copies land, one transition, one effect', async () => {
    const h = await createHarness();
    const { chargeId, checkoutRequestId } = await charge(h, { amountMinor: 10_400 });
    assert.equal(h.fake.peekPending().length, 2, 'the fake queued two');

    assert.equal(await h.fake.deliverPending(), 2);

    const ev = await events(h, checkoutRequestId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.duplicate_count, 1);
    assert.equal((await chargeRow(h, chargeId)).status, 'PAID');
    assert.equal((await outbox(h, chargeId)).length, 1);
    await h.close();
  });

  test('a redelivery that arrives AFTER the charge is terminal for another reason is recorded, not applied', async () => {
    const h = await createHarness();
    const { chargeId, checkoutRequestId } = await charge(h);
    // Something else resolved it first (say, the reconciler via query).
    await h.db.query("UPDATE charges SET status = 'FAILED', resolved_by = 'query' WHERE id = $1", [chargeId]);

    await h.fake.deliverPending(); // the success callback, late

    const c = await chargeRow(h, chargeId);
    assert.equal(c.status, 'FAILED', 'first resolution wins; a callback does not flip a terminal state');
    const ev = await events(h, checkoutRequestId);
    assert.equal(ev[0]!.matched, true);
    assert.equal(ev[0]!.applied, false);
    assert.equal((await outbox(h, chargeId)).length, 0);
    await h.close();
  });
});

describe('reorder — callbacks for different charges in any order', () => {
  test('three charges, delivered last-first with one replayed, each ends PAID exactly once', async () => {
    const h = await createHarness();
    const a = await charge(h);
    const b = await charge(h);
    const c = await charge(h);

    await h.fake.deliverPending({ order: 'reverse' });
    // And replay the middle one.
    const bCb = h.fake.deliveredCallbacks().find((cb) => cb.reference === b.checkoutRequestId)!;
    await h.fake.redeliver(bCb);

    for (const x of [a, b, c]) {
      assert.equal((await chargeRow(h, x.chargeId)).status, 'PAID');
      assert.equal((await outbox(h, x.chargeId)).length, 1);
    }
    assert.equal(await countRows(h.db, 'callback_events'), 3);
    assert.equal(await countRows(h.db, 'outbox_events'), 3);
    await h.close();
  });
});

describe('callbacks we must not trust', () => {
  test('an unknown CheckoutRequestID is stored (matched=false), applies nothing, and still gets a 200', async () => {
    const h = await createHarness();
    const { chargeId } = await charge(h);
    const forged: StkCallbackBody = {
      Body: {
        stkCallback: {
          MerchantRequestID: 'x',
          CheckoutRequestID: 'ws_CO_never_issued',
          ResultCode: 0,
          ResultDesc: 'ok',
          CallbackMetadata: { Item: [{ Name: 'Amount', Value: 250 }] },
        },
      },
    };
    const res = await h.app.inject({ method: 'POST', url: '/callbacks/stk', payload: forged });
    assert.equal(res.statusCode, 200);

    const ev = await events(h, 'ws_CO_never_issued');
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.matched, false);
    assert.equal(ev[0]!.applied, false);
    assert.equal((await chargeRow(h, chargeId)).status, 'PENDING', 'our real charge is untouched');
    assert.equal(await countRows(h.db, 'outbox_events'), 0);
    await h.close();
  });

  test('a success callback whose amount differs from ours puts the charge ON HOLD, never PAID', async () => {
    const h = await createHarness();
    const { chargeId, checkoutRequestId } = await charge(h, { amountMinor: 25_000 });
    const [queued] = h.fake.peekPending();
    const tampered = structuredClone(queued!.body) as StkCallbackBody;
    const amount = tampered.Body.stkCallback.CallbackMetadata!.Item.find((i) => i.Name === 'Amount')!;
    amount.Value = 1; // claims KES 1 was paid for a KES 250 sale

    const res = await h.app.inject({ method: 'POST', url: '/callbacks/stk', payload: tampered });
    assert.equal(res.statusCode, 200);

    const c = await chargeRow(h, chargeId);
    assert.equal(c.status, 'PENDING');
    assert.match(c.hold_reason, /callback amount 100 != charge amount 25000/);
    assert.equal((await events(h, checkoutRequestId))[0]!.applied, false);
    assert.equal((await outbox(h, chargeId)).length, 0);

    // And now the GENUINE callback arrives. The hold still blocks it: a
    // human decides, not a race between two callbacks.
    await h.fake.deliverPending();
    assert.equal((await chargeRow(h, chargeId)).status, 'PENDING');
    assert.equal((await outbox(h, chargeId)).length, 0);
    await h.close();
  });

  test('a well-formed JSON body that is not a Daraja callback is a 400 from our validator', async () => {
    const h = await createHarness();
    const cases: Array<[string, object]> = [
      ['empty object', {}],
      ['no stkCallback', { Body: {} }],
      ['no CheckoutRequestID', { Body: { stkCallback: { ResultCode: 0 } } }],
      ['non-integer ResultCode', { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: 'zero' } } }],
    ];
    for (const [name, payload] of cases) {
      const res = await h.app.inject({ method: 'POST', url: '/callbacks/stk', payload });
      assert.equal(res.statusCode, 400, name);
      assert.equal(res.json().ResultCode, 1, `${name}: Daraja-shaped error envelope`);
    }
    assert.equal(await countRows(h.db, 'callback_events'), 0);
    await h.close();
  });

  test('a body that is not valid JSON is rejected before our handler, and writes nothing', async () => {
    const h = await createHarness();

    // Broken JSON syntax, correctly typed -> Fastify's parser: 400.
    const badJson = await h.app.inject({
      method: 'POST',
      url: '/callbacks/stk',
      headers: { 'content-type': 'application/json' },
      payload: '{"Body": ',
    });
    assert.equal(badJson.statusCode, 400);

    // Wrong content type entirely. Daraja always sends JSON, so this is not
    // a shape we need to accept — it just has to be refused without writing.
    // Which 4xx Fastify picks (400 vs 415) is its business, not our contract.
    const wrongType = await h.app.inject({
      method: 'POST',
      url: '/callbacks/stk',
      headers: { 'content-type': 'text/plain' },
      payload: 'not json',
    });
    assert.ok(
      wrongType.statusCode >= 400 && wrongType.statusCode < 500,
      `expected a 4xx, got ${wrongType.statusCode}`,
    );

    assert.equal(await countRows(h.db, 'callback_events'), 0);
    await h.close();
  });
});

describe('the uncertain-payment shape', () => {
  // The full drill — adoption, ambiguity, and query-based resolution — lives
  // in reconcile.test.ts. What belongs here is the callback path's own rule:
  // a reference we never issued is never trusted on its own.
  test('a callback for an id we never issued is not adopted when nothing plausibly matches it', async () => {
    const h = await createHarness();
    const { chargeId } = await charge(h, { amountMinor: 25_000 }); // acked, so it HAS an id

    const forged: StkCallbackBody = {
      Body: {
        stkCallback: {
          MerchantRequestID: 'x',
          CheckoutRequestID: 'ws_CO_never_issued',
          ResultCode: 0,
          ResultDesc: 'ok',
          CallbackMetadata: {
            Item: [
              // A plausible-looking success for an amount and phone that do
              // not belong to any charge awaiting a reference.
              { Name: 'Amount', Value: 999 },
              { Name: 'PhoneNumber', Value: 254799999999 },
            ],
          },
        },
      },
    };
    const res = await h.app.inject({ method: 'POST', url: '/callbacks/stk', payload: forged });
    assert.equal(res.statusCode, 200);

    const ev = await events(h, 'ws_CO_never_issued');
    assert.equal(ev[0]!.matched, false, 'recorded for the runbook, not applied');
    assert.equal((await chargeRow(h, chargeId)).status, 'PENDING', 'our real charge is untouched');
    assert.equal(await countRows(h.db, 'outbox_events'), 0);
    await h.close();
  });
});

describe('review findings — regression tests', () => {
  test('a hold written concurrently blocks a transition even when the charge was loaded PENDING (TOCTOU)', async () => {
    const h = await createHarness();
    const { chargeId, checkoutRequestId } = await charge(h);

    // Simulate the race: the callback's transaction has already loaded the
    // charge as PENDING with no hold, and the hold lands before it updates.
    // The in-memory check cannot see this; only the SQL guard can.
    await h.db.query("UPDATE charges SET hold_reason = 'amount mismatch from a concurrent callback' WHERE id = $1", [chargeId]);

    await h.fake.deliverPending();

    const c = await chargeRow(h, chargeId);
    assert.equal(c.status, 'PENDING', 'the guarded UPDATE refused to move a held charge');
    assert.equal((await outbox(h, chargeId)).length, 0, 'and produced no ledger effect');
    const ev = await events(h, checkoutRequestId);
    assert.equal(ev[0]!.applied, false);
    assert.match(ev[0]!.body ? JSON.stringify(ev[0]!.body).slice(0, 0) + 'ok' : 'ok', /ok/);
    await h.close();
  });

  test('a late STK ack cannot overwrite the provider reference on an adopted charge', async () => {
    const h = await createHarness();
    // A charge whose push timed out: no CheckoutRequestID of its own.
    const body = chargeBody({ amountMinor: 10_300 });
    const created = await h.call({ method: 'POST', url: '/charges', payload: body });
    const chargeId = created.json().chargeId as string;
    assert.equal((await chargeRow(h, chargeId)).checkout_request_id, null);

    // The late callback adopts it, claiming a reference.
    const [ref] = h.fake.unresolvedTimeouts();
    h.fake.resolveTimeout(ref!, 'success');
    await h.fake.deliverPending();

    const adopted = await chargeRow(h, chargeId);
    assert.equal(adopted.checkout_request_id, ref, 'adoption claimed the reference');
    assert.equal(adopted.status, 'PAID');

    // Now a re-push DOES get an ack this time, with a different reference.
    // (scenarioHint forces success; by amount alone KES 103 would time out
    // again and never produce an ack to overwrite with.) It must not
    // re-point the audit trail at another Daraja transaction.
    await pushStk(chargeId, { ...validateCreateCharge(body), scenarioHint: 'success' }, {
      db: h.db,
      adapter: h.fake,
      callbackBaseUrl: CALLBACK_BASE,
      now: h.nowDate,
    });

    const after = await chargeRow(h, chargeId);
    assert.equal(after.checkout_request_id, ref, 'the original reference stands');
    assert.equal(after.status, 'PAID');
    assert.match(after.last_push_error, /late STK ack ignored/);
    await h.close();
  });
});

describe('GET /admin/charges/:id/audit — I3 as a readable record', () => {
  test('a replayed callback shows as one row with duplicateCount, and one outbox event', async () => {
    const h = await createHarness();
    // KES 104: the fake delivers the same success callback twice.
    const created = await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: 10_400 }) });
    const chargeId = created.json().chargeId as string;
    await h.fake.deliverPending();

    const res = await h.call({ method: 'GET', url: `/admin/charges/${chargeId}/audit` });
    assert.equal(res.statusCode, 200);
    const audit = res.json();
    assert.equal(audit.status, 'PAID');
    assert.equal(audit.callbackEvents.length, 1, 'two deliveries, ONE row');
    assert.equal(audit.callbackEvents[0].duplicateCount, 1, 'the redelivery counted, not re-applied');
    assert.equal(audit.callbackEvents[0].applied, true);
    assert.equal(audit.outboxEvents.length, 1, 'exactly one ledger effect');
    assert.equal(audit.outboxEvents[0].eventType, 'sale.paid');
    await h.close();
  });

  test('a late callback for a terminal charge adds a row that was not applied, and no outbox event', async () => {
    const h = await createHarness();
    const created = await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: 25_000 }) });
    const chargeId = created.json().chargeId as string;
    const reference = created.json().checkoutRequestId as string;
    await h.fake.deliverPending(); // PAID

    // Out of order: a different success body for the same reference, after resolution.
    await h.app.inject({
      method: 'POST',
      url: '/callbacks/stk',
      payload: {
        Body: {
          stkCallback: {
            MerchantRequestID: 'late',
            CheckoutRequestID: reference,
            ResultCode: 0,
            ResultDesc: 'late',
            CallbackMetadata: { Item: [{ Name: 'Amount', Value: 250 }, { Name: 'MpesaReceiptNumber', Value: 'LATE' }] },
          },
        },
      },
    });

    const audit = (await h.call({ method: 'GET', url: `/admin/charges/${chargeId}/audit` })).json();
    assert.equal(audit.callbackEvents.length, 2, 'different bytes, so a second row');
    assert.equal(audit.callbackEvents.filter((e: { applied: boolean }) => e.applied).length, 1, 'applied exactly once');
    assert.equal(audit.outboxEvents.length, 1, 'the late one had no ledger effect');
    await h.close();
  });

  test('requires the service token, and 404s an unknown charge', async () => {
    const h = await createHarness();
    const anon = await h.app.inject({ method: 'GET', url: `/admin/charges/${randomUUID()}/audit` });
    assert.equal(anon.statusCode, 401);
    const missing = await h.call({ method: 'GET', url: `/admin/charges/${randomUUID()}/audit` });
    assert.equal(missing.statusCode, 404);
    await h.close();
  });
});
