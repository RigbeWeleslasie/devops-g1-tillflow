/**
 * Reconciliation — the other half of I5. "A timeout is not a decline" is
 * only honest if something eventually establishes what happened, without
 * ever guessing.
 *
 * This file is the uncertain-payment drill from docs/runbook.md §2.1,
 * executed: force a timeout, keep it pending, query/reconcile, and prove a
 * retry cannot create a second charge or a second ledger effect.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { STK_RESULT, type MpesaAdapter, type StkCallbackBody } from '@tillflow/mpesa';
import {
  createHarness,
  chargeBody,
  countRows,
  RECONCILE_AFTER_MS as AFTER_MS,
  RECONCILE_MAX_ATTEMPTS as MAX_ATTEMPTS,
  type Harness,
} from './harness.js';
import { runReconcileOnce, chargesNeedingAttention } from '../src/services/reconcileService.js';

function reconcile(h: Harness, adapter?: MpesaAdapter) {
  return runReconcileOnce({
    db: h.db,
    adapter: adapter ?? h.fake,
    afterMs: AFTER_MS,
    maxAttempts: MAX_ATTEMPTS,
    now: h.nowDate,
  });
}

async function chargeRow(h: Harness, id: string) {
  const r = await h.db.query('SELECT * FROM charges WHERE id = $1', [id]);
  return r.rows[0]!;
}

async function makeCharge(h: Harness, overrides: Record<string, unknown> = {}) {
  const body = chargeBody(overrides);
  const res = await h.call({ method: 'POST', url: '/charges', payload: body });
  return { body, chargeId: res.json().chargeId as string, checkoutRequestId: res.json().checkoutRequestId as string | null };
}

describe('the uncertain-payment drill: timeout -> pending -> query -> resolved', () => {
  test('a charge whose push timed out has no id to query, so reconcile leaves it PENDING and counts the look', async () => {
    const h = await createHarness();
    const { chargeId } = await makeCharge(h, { amountMinor: 10_300 }); // KES 103: timeout
    assert.equal((await chargeRow(h, chargeId)).checkout_request_id, null);

    h.advance(AFTER_MS + 1_000);
    const summary = await reconcile(h);

    assert.equal(summary.unqueryable, 1);
    assert.equal(summary.resolvedPaid, 0);
    const c = await chargeRow(h, chargeId);
    assert.equal(c.status, 'PENDING', 'never auto-failed');
    assert.equal(c.reconcile_attempts, 1);
    await h.close();
  });

  test('the late callback ADOPTS the timed-out charge: one transition, one ledger effect', async () => {
    const h = await createHarness();
    const { body, chargeId } = await makeCharge(h, { amountMinor: 10_300 });

    // The customer did pay. Daraja eventually calls back with an id we have
    // never seen, because our push never got a response.
    const [ref] = h.fake.unresolvedTimeouts();
    h.fake.resolveTimeout(ref!, 'success');
    h.advance(60_000);
    await h.fake.deliverPending();

    const c = await chargeRow(h, chargeId);
    assert.equal(c.status, 'PAID', 'the money is accounted for');
    assert.equal(c.checkout_request_id, ref, 'and the charge now owns the provider reference');

    const ev = await h.db.query('SELECT * FROM callback_events WHERE reference = $1', [ref]);
    assert.equal(ev.rows[0]?.matched, true);
    assert.equal(ev.rows[0]?.applied, true);

    const ob = await h.db.query("SELECT * FROM outbox_events WHERE aggregate_id = $1", [chargeId]);
    assert.equal(ob.rowCount, 1, 'exactly one sale.paid');
    const payload = typeof ob.rows[0]!.payload === 'string' ? JSON.parse(ob.rows[0]!.payload) : ob.rows[0]!.payload;
    assert.equal(payload.data.saleId, body['saleId']);
    await h.close();
  });

  test('adoption is refused when two timed-out charges share a phone and amount — neither is guessed at', async () => {
    const h = await createHarness();
    const msisdn = '254708374149';
    const a = await makeCharge(h, { amountMinor: 10_300, customerMsisdn: msisdn });
    const b = await makeCharge(h, { amountMinor: 10_300, customerMsisdn: msisdn });

    const refs = h.fake.unresolvedTimeouts();
    assert.equal(refs.length, 2);
    h.fake.resolveTimeout(refs[0]!, 'success');
    await h.fake.deliverPending();

    assert.equal((await chargeRow(h, a.chargeId)).status, 'PENDING');
    assert.equal((await chargeRow(h, b.chargeId)).status, 'PENDING');
    assert.equal(await countRows(h.db, 'outbox_events'), 0, 'no sale is credited on a guess');

    const ev = await h.db.query('SELECT * FROM callback_events WHERE reference = $1', [refs[0]]);
    assert.equal(ev.rows[0]?.matched, false);
    await h.close();
  });

  test('a retry after a timeout still creates no second charge and no second effect, even once resolved', async () => {
    const h = await createHarness();
    const body = chargeBody({ amountMinor: 10_300 });
    await h.call({ method: 'POST', url: '/charges', payload: body });

    const [ref] = h.fake.unresolvedTimeouts();
    h.fake.resolveTimeout(ref!, 'success');
    await h.fake.deliverPending();

    // POS retries /charges after its own timeout, as its client is allowed to.
    const retry = await h.call({ method: 'POST', url: '/charges', payload: body });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().status, 'PAID', 'it reads back the real state');

    assert.equal(await countRows(h.db, 'charges'), 1);
    assert.equal(await countRows(h.db, 'outbox_events'), 1);
    assert.equal(h.fake.unresolvedTimeouts().length, 0, 'and no second push happened');
    await h.close();
  });
});

describe('query-based resolution', () => {
  test('a charge Daraja reports as successful is resolved PAID by query, with one ledger effect', async () => {
    const h = await createHarness();
    // delayed_callback: acked, so we HAVE a CheckoutRequestID, but no
    // callback has landed yet — exactly what the reconciler is for.
    const { chargeId } = await makeCharge(h, { amountMinor: 10_500 }); // KES 105

    h.advance(AFTER_MS + 1_000); // now past the delay, so the fake's query answers
    const summary = await reconcile(h);

    assert.equal(summary.resolvedPaid, 1);
    const c = await chargeRow(h, chargeId);
    assert.equal(c.status, 'PAID');
    assert.equal(c.resolved_by, 'query');
    assert.equal(c.mpesa_receipt, null, 'stkQuery carries no receipt; the callback would have');
    assert.equal(await countRows(h.db, 'outbox_events'), 1);
    await h.close();
  });

  test('a charge Daraja reports as cancelled is resolved FAILED by query, with no ledger effect', async () => {
    const h = await createHarness();
    const { chargeId } = await makeCharge(h, { amountMinor: 10_100 }); // KES 101: cancelled
    // Drop the queued callback so only the query can resolve it.
    await h.fake.deliverPending.call(h.fake, {}); // deliver the decline callback
    await h.db.query("UPDATE charges SET status = 'PENDING', result_code = NULL, resolved_by = NULL, failed_at = NULL WHERE id = $1", [chargeId]);

    h.advance(AFTER_MS + 1_000);
    const summary = await reconcile(h);

    assert.equal(summary.resolvedFailed, 1);
    const c = await chargeRow(h, chargeId);
    assert.equal(c.status, 'FAILED');
    assert.equal(c.result_code, STK_RESULT.CANCELLED_BY_USER);
    assert.equal(c.resolved_by, 'query');
    await h.close();
  });

  test('"still processing" is not an answer: attempts are counted, the charge stays PENDING', async () => {
    const h = await createHarness();
    const { chargeId } = await makeCharge(h, { amountMinor: 10_500 }); // delayed

    h.advance(AFTER_MS + 1_000);
    // Force the adapter to keep saying pending regardless of the clock.
    const alwaysPending: MpesaAdapter = {
      stkPush: h.fake.stkPush.bind(h.fake),
      stkQuery: async () => ({ status: 'pending' }),
      b2cPayment: h.fake.b2cPayment.bind(h.fake),
    };

    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const s = await reconcile(h, alwaysPending);
      if (i < MAX_ATTEMPTS) assert.equal(s.stillPending, 1, `pass ${i}`);
    }

    const c = await chargeRow(h, chargeId);
    assert.equal(c.status, 'PENDING', 'never auto-failed, no matter how many times we asked');
    assert.equal(c.reconcile_attempts, MAX_ATTEMPTS);

    // Past the cap it drops out of the candidate set and into the alert set.
    const after = await reconcile(h, alwaysPending);
    assert.equal(after.examined, 0, 'we stop asking');
    const attention = await chargesNeedingAttention(h.db, MAX_ATTEMPTS);
    assert.equal(attention.length, 1);
    assert.equal(attention[0]?.id, chargeId);
    await h.close();
  });

  test('a failing stkQuery is not a decision: the charge stays PENDING', async () => {
    const h = await createHarness();
    const { chargeId } = await makeCharge(h, { amountMinor: 10_500 });
    h.advance(AFTER_MS + 1_000);

    const broken: MpesaAdapter = {
      stkPush: h.fake.stkPush.bind(h.fake),
      stkQuery: async () => {
        throw new Error('ECONNRESET');
      },
      b2cPayment: h.fake.b2cPayment.bind(h.fake),
    };
    const summary = await reconcile(h, broken);

    assert.equal(summary.errors, 1);
    assert.equal((await chargeRow(h, chargeId)).status, 'PENDING');
    await h.close();
  });
});

describe('callback and query cannot both apply', () => {
  test('a callback that lands after the reconciler resolved the charge applies nothing', async () => {
    const h = await createHarness();
    const { chargeId, checkoutRequestId } = await makeCharge(h, { amountMinor: 10_500 });

    h.advance(AFTER_MS + 1_000);
    await reconcile(h); // resolves PAID by query
    assert.equal((await chargeRow(h, chargeId)).resolved_by, 'query');

    await h.fake.deliverPending(); // the real callback, late

    const c = await chargeRow(h, chargeId);
    assert.equal(c.resolved_by, 'query', 'first resolution wins');
    assert.equal(await countRows(h.db, 'outbox_events'), 1, 'still one ledger effect');
    const ev = await h.db.query('SELECT applied FROM callback_events WHERE reference = $1', [checkoutRequestId]);
    assert.equal(ev.rows[0]?.applied, false);
    await h.close();
  });

  test('a held charge is never resolved by the reconciler either', async () => {
    const h = await createHarness();
    const { chargeId } = await makeCharge(h, { amountMinor: 10_500 });
    await h.db.query("UPDATE charges SET hold_reason = 'amount mismatch' WHERE id = $1", [chargeId]);

    h.advance(AFTER_MS + 1_000);
    const summary = await reconcile(h);

    assert.equal(summary.examined, 0, 'held charges are not candidates');
    assert.equal((await chargeRow(h, chargeId)).status, 'PENDING');
    await h.close();
  });
});

describe('operator endpoints', () => {
  test('GET /admin/pending explains why each stuck charge is stuck', async () => {
    const h = await createHarness();
    const timedOut = await makeCharge(h, { amountMinor: 10_300 });
    const held = await makeCharge(h, { amountMinor: 25_000 });
    await h.db.query("UPDATE charges SET hold_reason = 'callback amount 100 != charge amount 25000' WHERE id = $1", [held.chargeId]);
    await h.db.query('UPDATE charges SET reconcile_attempts = $2 WHERE id = $1', [timedOut.chargeId, MAX_ATTEMPTS]);

    const res = await h.call({ method: 'GET', url: '/admin/pending' });
    assert.equal(res.statusCode, 200);
    const situations = res.json().charges.map((c: { situation: string }) => c.situation);
    assert.ok(situations.some((s: string) => s.includes('timed out')));
    assert.ok(situations.some((s: string) => s.includes('on hold')));
    await h.close();
  });

  test('POST /admin/charges/:id/release clears a hold so reconciliation can proceed; unknown id -> 404', async () => {
    const h = await createHarness();
    const { chargeId } = await makeCharge(h, { amountMinor: 10_500 });
    await h.db.query("UPDATE charges SET hold_reason = 'mismatch' WHERE id = $1", [chargeId]);

    const release = await h.call({ method: 'POST', url: `/admin/charges/${chargeId}/release` });
    assert.equal(release.statusCode, 200);
    assert.equal((await chargeRow(h, chargeId)).hold_reason, null);

    h.advance(AFTER_MS + 1_000);
    assert.equal((await reconcile(h)).resolvedPaid, 1, 'now it can resolve');

    const missing = await h.call({ method: 'POST', url: `/admin/charges/${randomUUID()}/release` });
    assert.equal(missing.statusCode, 404);
    await h.close();
  });

  test('POST /admin/reconcile runs a pass and returns the summary; it needs the service token', async () => {
    const h = await createHarness();
    await makeCharge(h, { amountMinor: 10_500 });
    h.advance(AFTER_MS + 1_000);

    const unauth = await h.app.inject({ method: 'POST', url: '/admin/reconcile' });
    assert.equal(unauth.statusCode, 401);

    const res = await h.call({ method: 'POST', url: '/admin/reconcile' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().resolvedPaid, 1);
    await h.close();
  });

  test('there is no endpoint that sets a charge PAID or FAILED by hand', async () => {
    const h = await createHarness();
    const { chargeId } = await makeCharge(h);
    for (const url of [`/admin/charges/${chargeId}/paid`, `/admin/charges/${chargeId}/fail`]) {
      const res = await h.call({ method: 'POST', url });
      assert.equal(res.statusCode, 404, `${url} must not exist`);
    }
    await h.close();
  });
});
