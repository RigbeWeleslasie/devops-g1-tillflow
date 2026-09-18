/**
 * POST /dev/tokens must default OFF. PR #21 review: POST /tenants is
 * intentionally unauthenticated (tenant #1 bootstrap) -- pairing that with
 * an opt-out /dev/tokens default lets anyone mint their own owner JWT with
 * no credential at all. The "on" direction was already covered
 * incidentally by every other test; the security-relevant "off" direction
 * had no assertion before this.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './testDb.js';
import { seedTenant } from './fixtures.js';
import { buildApp } from '../src/app.js';
import { FakePaymentsClient } from './fakes/fakePaymentsClient.js';

const TEST_SERVICE_TOKEN = 'test-service-token-0123456789abcdef';

test('POST /dev/tokens is a 404 by default -- no option, no env var', async () => {
  delete process.env['DEV_AUTH_ENABLED'];
  const { db } = createTestDb();
  const { tenant, owner } = await seedTenant(db);

  const app = await buildApp({
    serviceToken: TEST_SERVICE_TOKEN,
    db,
    paymentsClient: new FakePaymentsClient(),
    jwtSecret: 'test-secret',
    logger: false,
  });

  const res = await app.inject({
    method: 'POST',
    url: '/dev/tokens',
    payload: { tenantId: tenant.id, externalAuthId: owner.externalAuthId },
  });

  assert.equal(res.statusCode, 404, 'the route must not be mounted when nothing opts in');
});

test('POST /dev/tokens is a 404 when DEV_AUTH_ENABLED=false explicitly', async () => {
  const { db } = createTestDb();
  const { tenant, owner } = await seedTenant(db);

  const app = await buildApp({
    serviceToken: TEST_SERVICE_TOKEN,
    db,
    paymentsClient: new FakePaymentsClient(),
    jwtSecret: 'test-secret',
    logger: false,
    devAuthEnabled: false,
  });

  const res = await app.inject({
    method: 'POST',
    url: '/dev/tokens',
    payload: { tenantId: tenant.id, externalAuthId: owner.externalAuthId },
  });

  assert.equal(res.statusCode, 404);
});

test('POST /dev/tokens mints a working owner token when explicitly opted in', async () => {
  const { db } = createTestDb();
  const { tenant, owner } = await seedTenant(db);

  const app = await buildApp({
    serviceToken: TEST_SERVICE_TOKEN,
    db,
    paymentsClient: new FakePaymentsClient(),
    jwtSecret: 'test-secret',
    logger: false,
    devAuthEnabled: true,
  });

  const tokenRes = await app.inject({
    method: 'POST',
    url: '/dev/tokens',
    payload: { tenantId: tenant.id, externalAuthId: owner.externalAuthId },
  });
  assert.equal(tokenRes.statusCode, 200);
  const { token } = tokenRes.json();
  assert.equal(typeof token, 'string');

  const scopedRes = await app.inject({
    method: 'GET',
    url: `/tenants/${tenant.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(scopedRes.statusCode, 200, 'the minted token must actually authenticate a real route');
});
