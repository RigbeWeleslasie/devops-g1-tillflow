#!/usr/bin/env node
/**
 * G2 end-to-end sale demo, run for real (pg-mem-backed, no external
 * dependencies) and narrated to stdout — this is what evidence/product-pos/
 * points at as the reproduction command for "end-to-end sale demo".
 *
 * Run: npx tsx scripts/demo.ts
 */
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../test/testDb.js';
import { seedTenant } from '../test/fixtures.js';
import { buildApp } from '../src/app.js';
import { FakePaymentsClient } from '../test/fakes/fakePaymentsClient.js';
import { FakeEventSource } from '../src/workers/fakeEventSource.js';
import { runOnce } from '../src/workers/salePaidConsumer.js';
import type { SalePaidEvent } from '@tillflow/shared/events';

function step(n: number, title: string): void {
  console.log(`\n--- Step ${n}: ${title} ---`);
}

async function main(): Promise<void> {
  const { db } = createTestDb();
  const { tenant, owner, attendant, product } = await seedTenant(db, { productPriceMinor: 25000 }); // KES 250.00
  const paymentsClient = new FakePaymentsClient();
  const app = await buildApp({
    db,
    paymentsClient,
    jwtSecret: 'demo-secret',
    logger: false,
  });
  const token = app.jwt.sign({ sub: owner.id, tenantId: tenant.id, role: 'owner' });

  console.log('Tenant:', tenant.name, tenant.id);
  console.log('Attendant:', attendant.id);
  console.log('Product:', product.name, '@', product.unitPriceMinor, 'minor units');

  step(1, 'POST /sales (3x product, Idempotency-Key required)');
  const idempotencyKey = randomUUID();
  const createRes = await app.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: { attendantId: attendant.id, items: [{ productId: product.id, quantity: 3 }] },
  });
  const sale = createRes.json();
  console.log('->', createRes.statusCode, JSON.stringify(sale, null, 2));

  step(2, 'Duplicate POST /sales, SAME Idempotency-Key + body (I1 proof)');
  const dupRes = await app.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: { attendantId: attendant.id, items: [{ productId: product.id, quantity: 3 }] },
  });
  console.log('-> status', dupRes.statusCode, '(same as step 1)');
  console.log('-> same sale id?', dupRes.json().id === sale.id);
  const rowCount = await db.query('SELECT id FROM sales WHERE tenant_id = $1', [tenant.id]);
  console.log('-> sale rows in DB for this tenant:', rowCount.rowCount, '(must be 1)');

  step(3, 'Same Idempotency-Key, DIFFERENT body -> 409 (I1 proof)');
  const conflictRes = await app.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: { attendantId: attendant.id, items: [{ productId: product.id, quantity: 99 }] },
  });
  console.log('-> status', conflictRes.statusCode, JSON.stringify(conflictRes.json()));

  step(4, 'POST /sales/{id}/pay { customerMsisdn } -> POS calls Payments POST /charges');
  const payRes = await app.inject({
    method: 'POST',
    url: `/sales/${sale.id}/pay`,
    headers: { authorization: `Bearer ${token}` },
    payload: { customerMsisdn: '254708374149' },
  });
  console.log('->', payRes.statusCode, JSON.stringify(payRes.json(), null, 2));
  console.log('   Payments client saw:', JSON.stringify(paymentsClient.calls[0]));

  step(5, 'GET /sales/{id} — still UNPAID (pay only initiates the charge)');
  const afterPayRes = await app.inject({
    method: 'GET',
    url: `/sales/${sale.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  console.log('-> status:', afterPayRes.json().status);

  step(6, 'Payments confirms -> publishes sale.paid -> POS consumer applies it');
  const source = new FakeEventSource();
  const event: SalePaidEvent = {
    eventType: 'sale.paid',
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    data: {
      saleId: sale.id,
      tenantId: tenant.id,
      chargeId: payRes.json().charge.chargeId,
      amountMinor: sale.totalMinor,
      paidAt: new Date().toISOString(),
    },
  };
  source.publish(event);
  const handled = await runOnce({ db, source });
  console.log('-> consumer handled', handled, 'message(s)');

  step(7, 'GET /sales/{id} — now PAID');
  const finalRes = await app.inject({
    method: 'GET',
    url: `/sales/${sale.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  console.log('->', JSON.stringify(finalRes.json(), null, 2));

  step(8, 'IDOR check: a different tenant cannot read this sale');
  const otherTenant = await seedTenant(db);
  const otherToken = app.jwt.sign({ sub: otherTenant.owner.id, tenantId: otherTenant.tenant.id, role: 'owner' });
  const idorRes = await app.inject({
    method: 'GET',
    url: `/sales/${sale.id}`,
    headers: { authorization: `Bearer ${otherToken}` },
  });
  console.log('-> status:', idorRes.statusCode, JSON.stringify(idorRes.json()), '(must be 404, not 403)');

  await app.close();
  console.log('\nDemo complete.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
