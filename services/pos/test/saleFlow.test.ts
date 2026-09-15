/**
 * End-to-end: sale -> pay -> sale.paid consumed -> PAID. Exercises every
 * piece Rigbe's track owns working together, against the real HTTP routes
 * and the real consumer loop (in-process FakeEventSource standing in for
 * SQS — see workers/fakeEventSource.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './testDb.js';
import { seedTenant } from './fixtures.js';
import { buildApp } from '../src/app.js';
import { FakePaymentsClient } from './fakes/fakePaymentsClient.js';
import { FakeEventSource } from '../src/workers/fakeEventSource.js';
import { runOnce } from '../src/workers/salePaidConsumer.js';
import type { SalePaidEvent } from '@tillflow/shared/events';

test('e2e: sale is created UNPAID, pay initiates a charge, sale.paid moves it to PAID', async () => {
  const { db } = createTestDb();
  const { tenant, owner, attendant, product } = await seedTenant(db, { productPriceMinor: 250 });
  const paymentsClient = new FakePaymentsClient();
  const app = await buildApp({ db, paymentsClient, jwtSecret: 'test-secret', logger: false });
  const token = app.jwt.sign({ sub: owner.id, tenantId: tenant.id, role: 'owner' });

  // 1. Create the sale.
  const createRes = await app.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    payload: { attendantId: attendant.id, items: [{ productId: product.id, quantity: 3 }] },
  });
  assert.equal(createRes.statusCode, 201);
  const sale = createRes.json();
  assert.equal(sale.status, 'UNPAID');
  assert.equal(sale.totalMinor, 750, 'server-computed total: 250 * 3, never trusting a client-sent price');

  // 2. Pay — POS calls the (fake) Payments POST /charges contract.
  const payRes = await app.inject({
    method: 'POST',
    url: `/sales/${sale.id}/pay`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(payRes.statusCode, 202);
  const payBody = payRes.json();
  assert.equal(payBody.charge.status, 'PENDING');
  assert.ok(payBody.charge.chargeId);
  assert.equal(paymentsClient.calls.length, 1);
  assert.deepEqual(paymentsClient.calls[0], {
    saleId: sale.id,
    amountMinor: 750,
    tenantTill: tenant.tillNumber,
  });

  // Still UNPAID -- pay only *initiates* the charge. Only the sale.paid
  // event (step 3) may set PAID.
  const afterPayRes = await app.inject({
    method: 'GET',
    url: `/sales/${sale.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(afterPayRes.json().status, 'UNPAID');

  // 3. Payments confirms -> publishes sale.paid -> POS's consumer applies it.
  const source = new FakeEventSource();
  const event: SalePaidEvent = {
    eventType: 'sale.paid',
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    data: {
      saleId: sale.id,
      tenantId: tenant.id,
      chargeId: payBody.charge.chargeId,
      amountMinor: 750,
      paidAt: new Date().toISOString(),
    },
  };
  source.publish(event);
  const handled = await runOnce({ db, source });
  assert.equal(handled, 1);

  const finalRes = await app.inject({
    method: 'GET',
    url: `/sales/${sale.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  const finalSale = finalRes.json();
  assert.equal(finalSale.status, 'PAID');
  assert.ok(finalSale.paidAt);

  await app.close();
});

test('e2e: pay refuses a sale that is already PAID', async () => {
  const { db } = createTestDb();
  const { tenant, owner, attendant, product } = await seedTenant(db);
  const paymentsClient = new FakePaymentsClient();
  const app = await buildApp({ db, paymentsClient, jwtSecret: 'test-secret', logger: false });
  const token = app.jwt.sign({ sub: owner.id, tenantId: tenant.id, role: 'owner' });

  const createRes = await app.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    payload: { attendantId: attendant.id, items: [{ productId: product.id, quantity: 1 }] },
  });
  const sale = createRes.json();

  await app.inject({
    method: 'POST',
    url: `/sales/${sale.id}/pay`,
    headers: { authorization: `Bearer ${token}` },
  });

  const source = new FakeEventSource();
  source.publish({
    eventType: 'sale.paid',
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    data: { saleId: sale.id, tenantId: tenant.id, chargeId: randomUUID(), amountMinor: sale.totalMinor, paidAt: new Date().toISOString() },
  });
  await runOnce({ db, source });

  const secondPayRes = await app.inject({
    method: 'POST',
    url: `/sales/${sale.id}/pay`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(secondPayRes.statusCode, 409);

  await app.close();
});

test('e2e: a timed-out charge attempt leaves the sale UNPAID with no chargeId, never FAILED', async () => {
  const { db } = createTestDb();
  const { tenant, owner, attendant, product } = await seedTenant(db);
  const paymentsClient = new FakePaymentsClient('unknown'); // simulates the HTTP call to Payments timing out
  const app = await buildApp({ db, paymentsClient, jwtSecret: 'test-secret', logger: false });
  const token = app.jwt.sign({ sub: owner.id, tenantId: tenant.id, role: 'owner' });

  const createRes = await app.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    payload: { attendantId: attendant.id, items: [{ productId: product.id, quantity: 1 }] },
  });
  const sale = createRes.json();

  const payRes = await app.inject({
    method: 'POST',
    url: `/sales/${sale.id}/pay`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(payRes.statusCode, 202);
  assert.equal(payRes.json().charge.status, 'UNKNOWN');

  const afterRes = await app.inject({
    method: 'GET',
    url: `/sales/${sale.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  const afterSale = afterRes.json();
  assert.equal(afterSale.status, 'UNPAID', 'never FAILED — status enum does not even have a FAILED value');
  assert.equal(afterSale.chargeId, null);

  await app.close();
});
