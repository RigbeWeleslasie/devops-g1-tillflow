/**
 * I1 — one sale per idempotency key.
 *   - Duplicate POST /sales, same body -> the first response, no second row.
 *   - Same key, different body -> 409.
 * Both proven at the service layer (unit) and the HTTP layer (integration,
 * via app.inject — no real network socket, but the real Fastify routing +
 * JSON serialization + status codes a client actually sees).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './testDb.js';
import { seedTenant } from './fixtures.js';
import { buildApp } from '../src/app.js';
import {
  createSale,
  IdempotencyConflictError,
} from '../src/services/saleService.js';
import { FakePaymentsClient } from './fakes/fakePaymentsClient.js';

const TEST_SERVICE_TOKEN = 'test-service-token-0123456789abcdef';

test('service layer: duplicate POST /sales body returns the first response, creates no second row', async () => {
  const { db } = createTestDb();
  const { tenant, attendant, product } = await seedTenant(db);
  const idempotencyKey = randomUUID();
  const items = [{ productId: product.id, quantity: 2 }];

  const first = await createSale(db, tenant.id, attendant.id, items, idempotencyKey);
  const second = await createSale(db, tenant.id, attendant.id, items, idempotencyKey);

  assert.equal(second.status, first.status);
  assert.deepEqual(second.body, first.body);

  const rows = await db.query('SELECT id FROM sales WHERE tenant_id = $1', [tenant.id]);
  assert.equal(rows.rowCount, 1, 'exactly one sale row must exist after the duplicate call');
});

test('service layer: same key, different body -> IdempotencyConflictError (maps to 409)', async () => {
  const { db } = createTestDb();
  const { tenant, attendant, product } = await seedTenant(db);
  const idempotencyKey = randomUUID();

  await createSale(db, tenant.id, attendant.id, [{ productId: product.id, quantity: 1 }], idempotencyKey);

  await assert.rejects(
    () => createSale(db, tenant.id, attendant.id, [{ productId: product.id, quantity: 2 }], idempotencyKey),
    IdempotencyConflictError,
  );

  const rows = await db.query('SELECT id FROM sales WHERE tenant_id = $1', [tenant.id]);
  assert.equal(rows.rowCount, 1, 'the conflicting request must not create a second sale');
});

// NOT tested here: a genuine concurrent race on the same Idempotency-Key
// (two callers' transactions overlapping, both past the initial existence
// check before either commits). createSale's unique-violation catch exists
// for exactly that case and is correct against real Postgres — a composite
// PRIMARY KEY on (tenant_id, idempotency_key) is enforced with real
// cross-transaction row locking there (confirmed pg-mem enforces the same
// constraint correctly for sequential inserts — see the manual check in
// docs/scar-log.md). What pg-mem does NOT provide is genuine snapshot
// isolation between concurrently-open transactions on the same in-process
// instance: two overlapping `withTransaction` calls against it can both
// pass the pre-insert uniqueness check and both commit, which two real
// Postgres transactions cannot do. Proving the race case for real needs an
// actual Postgres connection (RDS, or a local instance) — a G3/G4 k6 or
// integration-test candidate, not something pg-mem can honestly validate.

test('HTTP layer: POST /sales requires Idempotency-Key', async () => {
  const { db } = createTestDb();
  const { tenant, owner, attendant, product } = await seedTenant(db);
  const app = await buildApp({ serviceToken: TEST_SERVICE_TOKEN,
    db,
    paymentsClient: new FakePaymentsClient(),
    jwtSecret: 'test-secret',
    logger: false,
  });
  const token = app.jwt.sign({ sub: owner.id, tenantId: tenant.id, role: 'owner' });

  const res = await app.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${token}` },
    payload: { attendantId: attendant.id, items: [{ productId: product.id, quantity: 1 }] },
  });

  assert.equal(res.statusCode, 400);
  await app.close();
});

test('HTTP layer: duplicate POST /sales (same key, same body) returns identical 201s and one row', async () => {
  const { db } = createTestDb();
  const { tenant, owner, attendant, product } = await seedTenant(db);
  const app = await buildApp({ serviceToken: TEST_SERVICE_TOKEN,
    db,
    paymentsClient: new FakePaymentsClient(),
    jwtSecret: 'test-secret',
    logger: false,
  });
  const token = app.jwt.sign({ sub: owner.id, tenantId: tenant.id, role: 'owner' });
  const idempotencyKey = randomUUID();
  const payload = { attendantId: attendant.id, items: [{ productId: product.id, quantity: 4 }] };

  const first = await app.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload,
  });
  const second = await app.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload,
  });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.deepEqual(second.json(), first.json());

  const rows = await db.query('SELECT id FROM sales WHERE tenant_id = $1', [tenant.id]);
  assert.equal(rows.rowCount, 1);
  await app.close();
});

test('HTTP layer: same Idempotency-Key, different body -> 409', async () => {
  const { db } = createTestDb();
  const { tenant, owner, attendant, product } = await seedTenant(db);
  const app = await buildApp({ serviceToken: TEST_SERVICE_TOKEN,
    db,
    paymentsClient: new FakePaymentsClient(),
    jwtSecret: 'test-secret',
    logger: false,
  });
  const token = app.jwt.sign({ sub: owner.id, tenantId: tenant.id, role: 'owner' });
  const idempotencyKey = randomUUID();

  const first = await app.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: { attendantId: attendant.id, items: [{ productId: product.id, quantity: 1 }] },
  });
  const second = await app.inject({
    method: 'POST',
    url: '/sales',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: { attendantId: attendant.id, items: [{ productId: product.id, quantity: 2 }] },
  });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 409);
  await app.close();
});
