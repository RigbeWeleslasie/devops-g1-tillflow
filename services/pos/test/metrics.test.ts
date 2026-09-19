/**
 * The POS SLI metric (G3/G4), asserted through the real POST /sales route and
 * the real OpenTelemetry SDK -- never by calling `recordSaleWrite()` directly.
 * Same reasoning as services/payments/test/metrics.test.ts: an alarm built on
 * `pos_sale_write_total{result="ok"}` is only as good as the claim that a
 * real sale write actually produces that series, and a test that calls the
 * recorder itself only proves the recorder can count.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { collectMetrics, drainMetrics, shutdownMetrics } from './metricsHarness.js';
import { createTestDb } from './testDb.js';
import { seedTenant } from './fixtures.js';
import { buildApp } from '../src/app.js';
import { FakePaymentsClient } from './fakes/fakePaymentsClient.js';

const TEST_SERVICE_TOKEN = 'test-service-token-0123456789abcdef';
const SALE_WRITE = 'pos_sale_write_total';

beforeEach(drainMetrics);
after(shutdownMetrics);

async function harness() {
  const { db } = createTestDb();
  const seeded = await seedTenant(db);
  const app = await buildApp({
    db,
    paymentsClient: new FakePaymentsClient(),
    jwtSecret: 'test-secret',
    serviceToken: TEST_SERVICE_TOKEN,
    logger: false,
  });
  const token = app.jwt.sign({ sub: seeded.owner.id, tenantId: seeded.tenant.id, role: 'owner' });
  const post = (idempotencyKey: string) =>
    app.inject({
      method: 'POST',
      url: '/sales',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
      payload: { attendantId: seeded.attendant.id, items: [{ productId: seeded.product.id, quantity: 1 }] },
    });
  return { app, post };
}

describe('the instrument exists under the name docs/slo-error-budgets.md alarms on', () => {
  test('a new sale write emits exactly pos_sale_write_total{result="ok"}', async () => {
    const { app, post } = await harness();
    const res = await post(randomUUID());
    assert.equal(res.statusCode, 201);

    const m = await collectMetrics();
    assert.deepEqual(m.names(), [SALE_WRITE]);
    // A renamed instrument is indistinguishable from a broken service on a
    // dashboard, so the name is asserted literally, not derived from the
    // source constant it is supposed to match.
    assert.equal(m.descriptor(SALE_WRITE)?.name, 'pos_sale_write_total');
    assert.equal(m.counter(SALE_WRITE, { result: 'ok' }), 1);
    await app.close();
  });

  test('a duplicate POST with the same key emits result="idempotent", not a second "ok"', async () => {
    const { app, post } = await harness();
    const key = randomUUID();
    await post(key);
    await drainMetrics();

    const res = await post(key);
    assert.equal(res.statusCode, 201);

    const m = await collectMetrics();
    assert.equal(m.counter(SALE_WRITE, { result: 'idempotent' }), 1);
    assert.equal(m.counter(SALE_WRITE, { result: 'ok' }), 0, 'a replay must not also count as a fresh write');
    await app.close();
  });

  // NOT tested here, for the same reason services/pos/test/idempotency.test.ts
  // documents next to its own skipped race case: pg-mem does not provide real
  // snapshot isolation between two concurrently-open transactions, so the
  // unique_violation path (createSale's isUniqueViolation catch) cannot be
  // driven honestly without a real Postgres connection. The recorder call is
  // one line, at the one place that path returns
  // (saleService.ts's `recordSaleWrite('unique_violation')`), reviewable by
  // inspection until a real-Postgres G4 drill exercises it for real.
});
