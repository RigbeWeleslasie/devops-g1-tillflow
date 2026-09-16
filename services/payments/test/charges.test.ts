/**
 * POST /charges — I2 (one charge per sale, a retry never pushes twice) and
 * I5 (a timeout is not a decline). Every test drives the real route through
 * Fastify inject against pg-mem + the FakeAdapter.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MpesaRejectedError, MpesaTransportError, type MpesaAdapter } from '@tillflow/mpesa';
import { createHarness, chargeBody, countRows, SERVICE_TOKEN } from './harness.js';
import { buildApp } from '../src/app.js';
import { createTestDb } from './testDb.js';

describe('POST /charges — happy path', () => {
  test('creates a PENDING charge, pushes once, records the CheckoutRequestID', async () => {
    const h = await createHarness();
    const body = chargeBody();

    const res = await h.call({ method: 'POST', url: '/charges', payload: body });
    assert.equal(res.statusCode, 201);
    const json = res.json();
    assert.equal(json.status, 'PENDING');
    assert.equal(json.created, true);
    assert.equal(json.saleId, body['saleId']);
    assert.match(json.checkoutRequestId, /^ws_CO_fake_/);

    const row = await h.db.query('SELECT * FROM charges WHERE id = $1', [json.chargeId]);
    assert.equal(row.rows[0]?.stk_attempts, 1);
    assert.equal(row.rows[0]?.last_push_error, null);
    assert.equal(h.fake.peekPending().length, 1, 'one callback queued for the one push');
    await h.close();
  });
});

describe('I2 — one charge per sale', () => {
  test('a repeat POST for the same saleId returns the same charge and pushes NOTHING', async () => {
    const h = await createHarness();
    const body = chargeBody();

    const first = await h.call({ method: 'POST', url: '/charges', payload: body });
    const second = await h.call({ method: 'POST', url: '/charges', payload: body });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200, 'existing, not created');
    assert.equal(second.json().chargeId, first.json().chargeId);
    assert.equal(second.json().created, false);

    assert.equal(await countRows(h.db, 'charges'), 1, 'one row');
    assert.equal(h.fake.peekPending().length, 1, 'still exactly one push: the retry did not prompt the customer again');
    const row = await h.db.query('SELECT stk_attempts FROM charges WHERE sale_id = $1', [body['saleId']]);
    assert.equal(row.rows[0]?.stk_attempts, 1);
    await h.close();
  });

  test('a repeat with a DIFFERENT amount still returns the original charge (the sale is the key, not the body)', async () => {
    const h = await createHarness();
    const body = chargeBody({ amountMinor: 25_000 });
    const first = await h.call({ method: 'POST', url: '/charges', payload: body });
    const second = await h.call({ method: 'POST', url: '/charges', payload: { ...body, amountMinor: 99_900 } });
    assert.equal(second.json().chargeId, first.json().chargeId);
    assert.equal(second.json().amountMinor, 25_000, 'the original amount stands');
    await h.close();
  });

  test('concurrent POSTs for the same saleId converge on one charge and one push', async () => {
    const h = await createHarness();
    const body = chargeBody();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.call({ method: 'POST', url: '/charges', payload: body })),
    );
    const ids = new Set(results.map((r) => r.json().chargeId));
    assert.equal(ids.size, 1, 'every caller got the same charge');
    assert.equal(results.filter((r) => r.statusCode === 201).length, 1, 'exactly one creator');
    assert.equal(await countRows(h.db, 'charges'), 1);
    assert.equal(h.fake.peekPending().length, 1, 'one push for five callers');
    await h.close();
  });
});

describe('I5 — a timeout is not a decline', () => {
  test('a timed-out push leaves the charge PENDING with no CheckoutRequestID, and records why', async () => {
    const h = await createHarness();
    const body = chargeBody({ amountMinor: 10_300 }); // KES 103: timeout

    const res = await h.call({ method: 'POST', url: '/charges', payload: body });
    assert.equal(res.statusCode, 201, 'the charge exists — POS gets a chargeId to hold on to');
    assert.equal(res.json().status, 'PENDING', 'NOT failed');
    assert.equal(res.json().checkoutRequestId, null, 'we never heard back');

    const row = await h.db.query('SELECT * FROM charges WHERE id = $1', [res.json().chargeId]);
    assert.equal(row.rows[0]?.status, 'PENDING');
    assert.equal(row.rows[0]?.failed_at, null);
    assert.match(row.rows[0]?.last_push_error, /MpesaTimeoutError/);
    assert.equal(h.fake.unresolvedTimeouts().length, 1, 'Daraja "has" the request');
    await h.close();
  });

  test('a retry after a timeout returns the same PENDING charge and does NOT push again', async () => {
    const h = await createHarness();
    const body = chargeBody({ amountMinor: 10_300 });

    const first = await h.call({ method: 'POST', url: '/charges', payload: body });
    const retry = await h.call({ method: 'POST', url: '/charges', payload: body });

    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().chargeId, first.json().chargeId);
    assert.equal(retry.json().status, 'PENDING');
    assert.equal(h.fake.unresolvedTimeouts().length, 1, 'ONE push reached Daraja, not two — the customer is not prompted twice');
    const row = await h.db.query('SELECT stk_attempts FROM charges WHERE id = $1', [first.json().chargeId]);
    assert.equal(row.rows[0]?.stk_attempts, 1);
    await h.close();
  });

  test('a transport error (connection reset, Daraja 5xx) also stays PENDING', async () => {
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
    const res = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { 'x-service-token': SERVICE_TOKEN },
      payload: chargeBody(),
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().status, 'PENDING');
    const row = await db.query('SELECT status, last_push_error FROM charges');
    assert.equal(row.rows[0]?.status, 'PENDING');
    assert.match(row.rows[0]?.last_push_error, /ECONNRESET/);
    await app.close();
  });

  test('a definite 4xx rejection from Daraja IS a terminal answer: FAILED, with the reason', async () => {
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
    const res = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { 'x-service-token': SERVICE_TOKEN },
      payload: chargeBody(),
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().status, 'FAILED');
    const row = await db.query('SELECT status, result_desc, failed_at FROM charges');
    assert.equal(row.rows[0]?.status, 'FAILED');
    assert.match(row.rows[0]?.result_desc, /Invalid PhoneNumber/);
    assert.ok(row.rows[0]?.failed_at);
    await app.close();
  });
});

describe('validation boundary', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['missing customerMsisdn', { customerMsisdn: undefined }, 'missing_customer_msisdn'],
    ['malformed msisdn', { customerMsisdn: '0708374149' }, 'invalid_msisdn'],
    ['missing tenantId', { tenantId: undefined }, 'missing_tenant_id'],
    ['non-UUID saleId', { saleId: 'sale-1' }, 'invalid_sale_id'],
    ['fractional shillings', { amountMinor: 25_050 }, 'amount_not_whole_shillings'],
    ['zero amount', { amountMinor: 0 }, 'invalid_amount'],
    ['float amount', { amountMinor: 250.5 }, 'invalid_amount'],
    ['negative amount', { amountMinor: -100 }, 'invalid_amount'],
    ['string amount', { amountMinor: '25000' }, 'invalid_amount'],
    ['bad till', { tenantTill: 'abc' }, 'invalid_till'],
  ];
  for (const [name, overrides, code] of cases) {
    test(`${name} -> 400 ${code}, and no charge row`, async () => {
      const h = await createHarness();
      const body = chargeBody();
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete body[k];
        else body[k] = v;
      }
      const res = await h.call({ method: 'POST', url: '/charges', payload: body });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, code);
      assert.equal(await countRows(h.db, 'charges'), 0);
      assert.equal(h.fake.peekPending().length, 0, 'nothing was pushed');
      await h.close();
    });
  }
});

describe('service auth', () => {
  test('no token -> 401, nothing written', async () => {
    const h = await createHarness();
    const res = await h.app.inject({ method: 'POST', url: '/charges', payload: chargeBody() });
    assert.equal(res.statusCode, 401);
    assert.equal(await countRows(h.db, 'charges'), 0);
    await h.close();
  });

  test('wrong token -> 401', async () => {
    const h = await createHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/charges',
      headers: { 'x-service-token': 'not-the-token-xxxxxxxxxxxxxxx' },
      payload: chargeBody(),
    });
    assert.equal(res.statusCode, 401);
    await h.close();
  });

  test('health routes need no token', async () => {
    const h = await createHarness();
    for (const url of ['/health', '/ready', '/version']) {
      const res = await h.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
    }
    await h.close();
  });
});

describe('read-back', () => {
  test('GET /charges/:id and /charges/by-sale/:saleId return the charge; unknown -> 404', async () => {
    const h = await createHarness();
    const body = chargeBody();
    const created = await h.call({ method: 'POST', url: '/charges', payload: body });
    const id = created.json().chargeId;

    const byId = await h.call({ method: 'GET', url: `/charges/${id}` });
    assert.equal(byId.statusCode, 200);
    assert.equal(byId.json().saleId, body['saleId']);

    const bySale = await h.call({ method: 'GET', url: `/charges/by-sale/${body['saleId']}` });
    assert.equal(bySale.json().chargeId, id);

    const missing = await h.call({ method: 'GET', url: `/charges/${randomUUID()}` });
    assert.equal(missing.statusCode, 404);
    await h.close();
  });
});
