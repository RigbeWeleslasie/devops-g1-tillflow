/**
 * POST /dev/tokens must default OFF. PR #21 review: POST /tenants is
 * intentionally unauthenticated (tenant #1 bootstrap) -- pairing that with
 * an opt-out /dev/tokens default lets anyone mint their own owner JWT with
 * no credential at all. The "on" direction was already covered
 * incidentally by every other test; the security-relevant "off" direction
 * had no assertion before this.
 *
 * Second review pass on the same PR: every test above only exercised the
 * `devAuthEnabled` *option* -- never the `DEV_AUTH_ENABLED` *env var*, which
 * is the only mechanism `server.ts` (the real entrypoint) actually uses; it
 * calls `buildApp()` with no `devAuthEnabled` at all. A typo in the env var
 * name in auth.ts would ship green through every test here and 404 silently
 * in the deployed sandbox -- exactly the failure class this whole PR exists
 * to fix. `mints a working token when only DEV_AUTH_ENABLED=true is set`
 * below closes that: no option, env var only, matching server.ts exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './testDb.js';
import { seedTenant } from './fixtures.js';
import { buildApp } from '../src/app.js';
import { FakePaymentsClient } from './fakes/fakePaymentsClient.js';

const TEST_SERVICE_TOKEN = 'test-service-token-0123456789abcdef';

test('POST /dev/tokens is a 404 by default -- no option, no env var', async () => {
  const previous = process.env['DEV_AUTH_ENABLED'];
  delete process.env['DEV_AUTH_ENABLED'];
  try {
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
  } finally {
    if (previous === undefined) delete process.env['DEV_AUTH_ENABLED'];
    else process.env['DEV_AUTH_ENABLED'] = previous;
  }
});

test('POST /dev/tokens mints a working token when only DEV_AUTH_ENABLED=true is set -- the real server.ts path', async () => {
  const previous = process.env['DEV_AUTH_ENABLED'];
  process.env['DEV_AUTH_ENABLED'] = 'true';
  try {
    const { db } = createTestDb();
    const { tenant, owner } = await seedTenant(db);

    // No `devAuthEnabled` option -- matches server.ts's actual buildApp()
    // call exactly, so this only passes if the env-var read in auth.ts is
    // spelled the same way infra/service-mesh.tf spells it.
    const app = await buildApp({
      serviceToken: TEST_SERVICE_TOKEN,
      db,
      paymentsClient: new FakePaymentsClient(),
      jwtSecret: 'test-secret',
      logger: false,
    });

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/dev/tokens',
      payload: { tenantId: tenant.id, externalAuthId: owner.externalAuthId },
    });
    assert.equal(tokenRes.statusCode, 200, 'DEV_AUTH_ENABLED=true alone must mount the route');
    const { token } = tokenRes.json();
    assert.equal(typeof token, 'string');
  } finally {
    if (previous === undefined) delete process.env['DEV_AUTH_ENABLED'];
    else process.env['DEV_AUTH_ENABLED'] = previous;
  }
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
