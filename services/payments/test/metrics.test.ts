/**
 * The Payments SLI metrics (G3), asserted through the real routes and the real
 * OpenTelemetry SDK — never by calling `recordCommand()` directly.
 *
 * Why that distinction is the whole point of this file: an alarm built on
 * `payments_command_total{type="stk",result="accepted"}` is only as good as the
 * claim that a successful STK push actually produces that series. A test that
 * calls the recorder itself proves the recorder can count, which nobody
 * doubted. These tests drive `POST /charges`, `POST /callbacks/stk` and the
 * reconciler, and then read what the exporter would ship.
 *
 * The failure this guards against is specific and silent: a metric that is
 * never emitted, or emitted under a name or label nobody alarms on, produces a
 * CloudWatch alarm that sits in INSUFFICIENT_DATA forever and a budget panel
 * that renders empty — which looks like a working dashboard until you click it.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MpesaRejectedError, MpesaTransportError, type MpesaAdapter } from '@tillflow/mpesa';
import { collectMetrics, drainMetrics, shutdownMetrics } from './metricsHarness.js';
import { createHarness, chargeBody, SERVICE_TOKEN, RECONCILE_MAX_ATTEMPTS } from './harness.js';
import { buildApp } from '../src/app.js';
import { createTestDb } from './testDb.js';

const COMMANDS = 'payments_command_total';
const CALLBACK_SECONDS = 'payments_callback_process_seconds';
const RECONCILE = 'payments_reconcile_total';

/** KES 250 — scenario suffix 50, ordinary money, succeeds. */
const OK = 25_000;

beforeEach(drainMetrics);
after(shutdownMetrics);

describe('the instruments exist under the names docs/slo-error-budgets.md alarms on', () => {
  test('a charge and its callback emit exactly the two names the SLO names', async () => {
    const h = await createHarness();
    await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: OK }) });
    await h.fake.deliverPending();

    const m = await collectMetrics();
    assert.deepEqual(m.names(), [CALLBACK_SECONDS, COMMANDS]);

    // A renamed instrument is indistinguishable from a broken service on a
    // dashboard, so the name and the unit are asserted literally rather than
    // derived from the source constant they are supposed to match.
    assert.equal(m.descriptor(COMMANDS)?.name, 'payments_command_total');
    assert.equal(m.descriptor(CALLBACK_SECONDS)?.name, 'payments_callback_process_seconds');
    assert.equal(m.descriptor(CALLBACK_SECONDS)?.unit, 's', 'seconds — the SLO gate is "within 60s"');
    await h.close();
  });
});

describe('payments_command_total — STK', () => {
  test('a successful push is one `accepted`, and nothing else', async () => {
    const h = await createHarness();
    await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: OK }) });

    const m = await collectMetrics();
    assert.equal(m.counter(COMMANDS, { type: 'stk', result: 'accepted' }), 1);
    assert.equal(m.points(COMMANDS).length, 1, 'one series, not an accidental second label set');
    await h.close();
  });

  test('a repeat for the same sale is `idempotent`, not a second `accepted` (I2)', async () => {
    const h = await createHarness();
    const body = chargeBody({ amountMinor: OK });
    await h.call({ method: 'POST', url: '/charges', payload: body });
    await h.call({ method: 'POST', url: '/charges', payload: body });
    await h.call({ method: 'POST', url: '/charges', payload: body });

    const m = await collectMetrics();
    assert.equal(m.counter(COMMANDS, { type: 'stk', result: 'accepted' }), 1, 'one push ever reached Daraja');
    assert.equal(m.counter(COMMANDS, { type: 'stk', result: 'idempotent' }), 2, 'the two retries, counted as such');
    await h.close();
  });

  test('a timed-out push is `uncertain` and is NOT counted as rejected (I5)', async () => {
    const h = await createHarness();
    // KES 103 — the timeout scenario. The charge stays PENDING.
    await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: 10_300 }) });

    const m = await collectMetrics();
    assert.equal(m.counter(COMMANDS, { type: 'stk', result: 'uncertain' }), 1);
    assert.equal(
      m.counter(COMMANDS, { type: 'stk', result: 'rejected' }),
      0,
      'the single most expensive mislabel available: a timeout reported as a decline',
    );
    assert.equal(m.counter(COMMANDS, { type: 'stk', result: 'accepted' }), 0);
    await h.close();
  });

  test('a transport error is also `uncertain`', async () => {
    const { db } = createTestDb();
    const flaky: MpesaAdapter = {
      stkPush: async () => {
        throw new MpesaTransportError('ECONNRESET');
      },
      stkQuery: async () => ({ status: 'pending' }),
      b2cPayment: async () => {
        throw new Error('not used');
      },
    };
    const app = await buildApp({ db, adapter: flaky, serviceToken: SERVICE_TOKEN, callbackBaseUrl: 'http://x', logger: false });
    await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { 'x-service-token': SERVICE_TOKEN },
      payload: chargeBody(),
    });

    const m = await collectMetrics();
    assert.equal(m.counter(COMMANDS, { type: 'stk', result: 'uncertain' }), 1);
    await app.close();
  });

  test('a definite 4xx rejection IS `rejected` — the one push failure that is an error', async () => {
    const { db } = createTestDb();
    const rejecting: MpesaAdapter = {
      stkPush: async () => {
        throw new MpesaRejectedError('400.002.02', 'Bad Request - Invalid PhoneNumber');
      },
      stkQuery: async () => ({ status: 'pending' }),
      b2cPayment: async () => {
        throw new Error('not used');
      },
    };
    const app = await buildApp({ db, adapter: rejecting, serviceToken: SERVICE_TOKEN, callbackBaseUrl: 'http://x', logger: false });
    await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { 'x-service-token': SERVICE_TOKEN },
      payload: chargeBody(),
    });

    const m = await collectMetrics();
    assert.equal(m.counter(COMMANDS, { type: 'stk', result: 'rejected' }), 1);
    assert.equal(m.counter(COMMANDS, { type: 'stk', result: 'uncertain' }), 0);
    await app.close();
  });

  test('a rejected body never reaches the counter — 4xx validation is excluded from the SLI', async () => {
    const h = await createHarness();
    const res = await h.call({
      method: 'POST',
      url: '/charges',
      payload: chargeBody({ customerMsisdn: '0708374149' }),
    });
    assert.equal(res.statusCode, 400);

    const m = await collectMetrics();
    assert.deepEqual(m.points(COMMANDS), [], 'no command was ever placed, so none is counted');
    await h.close();
  });
});

describe('payments_callback_process_seconds', () => {
  test('a paid callback is one `applied_paid` observation, timed', async () => {
    const h = await createHarness();
    await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: OK }) });
    await drainMetrics(); // the push; this test is about the callback
    await h.fake.deliverPending();

    const m = await collectMetrics();
    const point = m.histogram(CALLBACK_SECONDS, { kind: 'stk', outcome: 'applied_paid' });
    assert.ok(point, 'the success path must produce the series the SLI numerator reads');
    assert.equal(point.count, 1);
    assert.ok(point.sum !== undefined && point.sum >= 0, 'a real elapsed time, in seconds');
    assert.ok(
      point.sum !== undefined && point.sum < 60,
      'and inside the 60s the SLO gates on — a frozen test clock would silently make this vacuous',
    );
    await h.close();
  });

  test('a business decline is `applied_declined`, kept apart from a failure', async () => {
    const h = await createHarness();
    // KES 102 — insufficient funds. A CORRECT outcome, excluded from the SLI.
    await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: 10_200 }) });
    await drainMetrics();
    await h.fake.deliverPending();

    const m = await collectMetrics();
    assert.equal(m.histogram(CALLBACK_SECONDS, { kind: 'stk', outcome: 'applied_declined' })?.count, 1);
    assert.equal(
      m.histogram(CALLBACK_SECONDS, { kind: 'stk', outcome: 'applied_paid' }),
      undefined,
      'the alarm math subtracts declines by label, so the label has to be right',
    );
    await h.close();
  });

  test('a redelivered callback is `duplicate` — the second delivery writes no state and says so', async () => {
    const h = await createHarness();
    // KES 104 — the fake sends the same callback twice.
    await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: 10_400 }) });
    await drainMetrics();
    await h.fake.deliverPending();

    const m = await collectMetrics();
    assert.equal(m.histogram(CALLBACK_SECONDS, { kind: 'stk', outcome: 'applied_paid' })?.count, 1);
    assert.equal(m.histogram(CALLBACK_SECONDS, { kind: 'stk', outcome: 'duplicate' })?.count, 1, 'I3, as a number');
    await h.close();
  });

  test('a callback for a reference we never issued is `unmatched`, not an error', async () => {
    const h = await createHarness();
    await h.app.inject({
      method: 'POST',
      url: '/callbacks/stk',
      payload: {
        Body: {
          stkCallback: {
            MerchantRequestID: 'x',
            CheckoutRequestID: 'ws_CO_nobody_issued_this',
            ResultCode: 0,
            ResultDesc: 'ok',
          },
        },
      },
    });

    const m = await collectMetrics();
    assert.equal(m.histogram(CALLBACK_SECONDS, { kind: 'stk', outcome: 'unmatched' })?.count, 1);
    await h.close();
  });

  test('an unparseable body is `malformed` and answered 400', async () => {
    const h = await createHarness();
    const res = await h.app.inject({ method: 'POST', url: '/callbacks/stk', payload: { nonsense: true } });
    assert.equal(res.statusCode, 400);

    const m = await collectMetrics();
    assert.equal(m.histogram(CALLBACK_SECONDS, { kind: 'stk', outcome: 'malformed' })?.count, 1);
    await h.close();
  });

  test('an amount mismatch is `held`, never `not_applied` — a hold is stuck money, not a no-op', async () => {
    const h = await createHarness();
    const created = await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: OK }) });
    const reference = created.json().checkoutRequestId;
    await drainMetrics();

    // Daraja reports KES 10 for a KES 250 charge (threat-model A1).
    await h.app.inject({
      method: 'POST',
      url: '/callbacks/stk',
      payload: {
        Body: {
          stkCallback: {
            MerchantRequestID: 'x',
            CheckoutRequestID: reference,
            ResultCode: 0,
            ResultDesc: 'ok',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 10 },
                { Name: 'MpesaReceiptNumber', Value: 'ABC123' },
                { Name: 'PhoneNumber', Value: 254708374149 },
              ],
            },
          },
        },
      },
    });

    const m = await collectMetrics();
    assert.equal(m.histogram(CALLBACK_SECONDS, { kind: 'stk', outcome: 'held' })?.count, 1);
    assert.equal(
      m.histogram(CALLBACK_SECONDS, { kind: 'stk', outcome: 'not_applied' }),
      undefined,
      'these two look identical on the outcome object — matched, not applied, no transition — ' +
        'and mean opposite things. `heldForReview` is what keeps them apart.',
    );

    const row = await h.db.query('SELECT hold_reason, status FROM charges WHERE checkout_request_id = $1', [reference]);
    assert.equal(row.rows[0]?.status, 'PENDING', 'and the charge really is held, not just labelled');
    assert.ok(row.rows[0]?.hold_reason);
    await h.close();
  });
});

describe('payments_reconcile_total — the counter that makes `uncertain` honest', () => {
  test('a charge resolved by stkQuery is `resolved_paid`', async () => {
    const { db } = createTestDb();
    let answer: 'pending' | 'paid' = 'pending';
    const adapter: MpesaAdapter = {
      stkPush: async () => ({
        merchantRequestId: 'm-1',
        checkoutRequestId: 'ws_CO_1',
        responseCode: '0',
        responseDescription: 'Success',
        customerMessage: 'Success',
      }),
      stkQuery: async () =>
        answer === 'pending'
          ? { status: 'pending' }
          : { status: 'complete', resultCode: 0, resultDesc: 'ok' },
      b2cPayment: async () => {
        throw new Error('not used');
      },
    };
    let nowMs = Date.parse('2026-09-15T10:00:00Z');
    const app = await buildApp({
      db,
      adapter,
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
    nowMs += 5 * 60_000; // past the reconcile threshold
    await drainMetrics();

    const runReconcile = (): Promise<unknown> =>
      app.inject({ method: 'POST', url: '/admin/reconcile', headers: { 'x-service-token': SERVICE_TOKEN } });

    await runReconcile();
    let m = await collectMetrics();
    assert.equal(m.counter(RECONCILE, { outcome: 'still_pending' }), 1, 'Daraja said "still processing"');
    assert.equal(m.counter(RECONCILE, { outcome: 'resolved_paid' }), 0);

    answer = 'paid';
    await runReconcile();
    m = await collectMetrics();
    assert.equal(m.counter(RECONCILE, { outcome: 'resolved_paid' }), 1, 'the uncertainty was resolved, and it shows');
    await app.close();
  });

  test('a charge the reconciler has given up on is `needs_attention` — the label that should page', async () => {
    const h = await createHarness();
    // KES 103: the push timed out, so there is no CheckoutRequestID to query.
    await h.call({ method: 'POST', url: '/charges', payload: chargeBody({ amountMinor: 10_300 }) });
    h.advance(5 * 60_000);
    await drainMetrics();

    for (let i = 0; i < RECONCILE_MAX_ATTEMPTS; i++) {
      await h.call({ method: 'POST', url: '/admin/reconcile' });
    }

    const m = await collectMetrics();
    assert.equal(
      m.counter(RECONCILE, { outcome: 'unqueryable' }),
      RECONCILE_MAX_ATTEMPTS,
      'every look found nothing to ask Daraja about',
    );
    assert.equal(
      m.counter(RECONCILE, { outcome: 'needs_attention' }),
      1,
      'and exactly one of them was the look that gave up — I5 stops being self-healing here',
    );
    await h.close();
  });
});

describe('payments_command_total — B2C', () => {
  /** A ledger row for the payout routes to disburse against. */
  async function seedLedger(h: Awaited<ReturnType<typeof createHarness>>, payoutMinor: number): Promise<string> {
    const id = crypto.randomUUID();
    await h.db.query(
      `INSERT INTO payout_ledger
         (id, tenant_id, attendant_id, business_day, amount_minor, payout_minor, remainder_minor,
          rate_bps, msisdn, sale_count, sale_total_minor, status, computed_at, updated_at)
       VALUES ($1, $2, $3, '2026-09-15', $4, $4, 0, 500, '254700000000', 1, 100000, 'COMPUTED', $5, $5)`,
      [id, crypto.randomUUID(), crypto.randomUUID(), payoutMinor, h.nowDate().toISOString()],
    );
    return id;
  }

  test('a disbursement is one `accepted`; re-requesting it is `idempotent` (I4)', async () => {
    const h = await createHarness();
    const ledgerId = await seedLedger(h, 120_000); // KES 1200 — ordinary money
    await drainMetrics();

    await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });
    await h.call({ method: 'POST', url: '/payouts', payload: { ledgerId } });

    const m = await collectMetrics();
    assert.equal(m.counter(COMMANDS, { type: 'b2c', result: 'accepted' }), 1, 'one disbursement');
    assert.equal(m.counter(COMMANDS, { type: 'b2c', result: 'idempotent' }), 1, 'and one correctly refused repeat');
    assert.equal(
      m.counter(COMMANDS, { type: 'b2c', result: 'accepted' }),
      1,
      'duplicate disbursement = 0, stated as a metric an alarm can hold to',
    );
    await h.close();
  });

  test("a B2C queue timeout is `held` — stuck money, not a no-op", async () => {
    const h = await createHarness();
    await h.app.inject({
      method: 'POST',
      url: '/callbacks/b2c-timeout',
      payload: { Result: { ConversationID: 'AG_1', OriginatorConversationID: 'x' } },
    });

    const m = await collectMetrics();
    assert.equal(m.histogram(CALLBACK_SECONDS, { kind: 'b2c', outcome: 'held' })?.count, 1);
    await h.close();
  });
});
