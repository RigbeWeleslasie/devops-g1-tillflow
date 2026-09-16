/**
 * IDOR — a cross-tenant read returns 404, not 403. No existence leak: a
 * caller from tenant B gets the exact same response for tenant A's real
 * sale id as for a random id that was never issued.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './testDb.js';
import { seedTenant } from './fixtures.js';
import { buildApp } from '../src/app.js';
import { getSale, createSale } from '../src/services/saleService.js';
import { FakePaymentsClient } from './fakes/fakePaymentsClient.js';

const TEST_SERVICE_TOKEN = 'test-service-token-0123456789abcdef';

test('service layer: getSale scoped to the wrong tenant returns null, not the row', async () => {
  const { db } = createTestDb();
  const tenantA = await seedTenant(db, { productPriceMinor: 300 });
  const tenantB = await seedTenant(db, { productPriceMinor: 500 });

  const { body: saleA } = await createSale(
    db,
    tenantA.tenant.id,
    tenantA.attendant.id,
    [{ productId: tenantA.product.id, quantity: 1 }],
    randomUUID(),
  );

  const asOwnTenant = await getSale(db, tenantA.tenant.id, saleA.id);
  const asOtherTenant = await getSale(db, tenantB.tenant.id, saleA.id);

  assert.ok(asOwnTenant, 'the owning tenant must see its own sale');
  assert.equal(asOtherTenant, null, 'a different tenant must get nothing back, not an error');
});

test('HTTP layer: cross-tenant GET /sales/:id returns 404, identical to a nonexistent id', async () => {
  const { db } = createTestDb();
  const tenantA = await seedTenant(db, { productPriceMinor: 300 });
  const tenantB = await seedTenant(db, { productPriceMinor: 500 });

  const app = await buildApp({ serviceToken: TEST_SERVICE_TOKEN,
    db,
    paymentsClient: new FakePaymentsClient(),
    jwtSecret: 'test-secret',
    logger: false,
  });

  const { body: saleA } = await createSale(
    db,
    tenantA.tenant.id,
    tenantA.attendant.id,
    [{ productId: tenantA.product.id, quantity: 1 }],
    randomUUID(),
  );

  const tokenA = app.jwt.sign({ sub: tenantA.owner.id, tenantId: tenantA.tenant.id, role: 'owner' });
  const tokenB = app.jwt.sign({ sub: tenantB.owner.id, tenantId: tenantB.tenant.id, role: 'owner' });

  const ownRead = await app.inject({
    method: 'GET',
    url: `/sales/${saleA.id}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  const crossTenantRead = await app.inject({
    method: 'GET',
    url: `/sales/${saleA.id}`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  const nonexistentRead = await app.inject({
    method: 'GET',
    url: `/sales/${randomUUID()}`,
    headers: { authorization: `Bearer ${tokenB}` },
  });

  assert.equal(ownRead.statusCode, 200);
  assert.equal(crossTenantRead.statusCode, 404, 'cross-tenant read must be 404, not 403 or 200');
  assert.equal(nonexistentRead.statusCode, 404);
  // The two 404s must be indistinguishable -- a real id belonging to
  // another tenant carries no more information than a made-up one.
  assert.deepEqual(crossTenantRead.json(), nonexistentRead.json());

  await app.close();
});

test('HTTP layer: cross-tenant GET /tenants/:id is also 404 (owner-route IDOR, not just sales)', async () => {
  const { db } = createTestDb();
  const tenantA = await seedTenant(db);
  const tenantB = await seedTenant(db);

  const app = await buildApp({ serviceToken: TEST_SERVICE_TOKEN,
    db,
    paymentsClient: new FakePaymentsClient(),
    jwtSecret: 'test-secret',
    logger: false,
  });
  const tokenB = app.jwt.sign({ sub: tenantB.owner.id, tenantId: tenantB.tenant.id, role: 'owner' });

  const res = await app.inject({
    method: 'GET',
    url: `/tenants/${tenantA.tenant.id}`,
    headers: { authorization: `Bearer ${tokenB}` },
  });

  assert.equal(res.statusCode, 404);
  await app.close();
});
