/**
 * GET /internal/daily-close — the contract the Commission worker reads.
 *
 * What matters here: only CONFIRMED PAID sales count, the business day is
 * Nairobi's not UTC's, per-sale amounts are returned (so the per-sale
 * rounding rule can be applied downstream), rates and MSISDNs are resolved
 * as of the close, and tenants are isolated from each other.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './testDb.js';
import { seedTenant } from './fixtures.js';
import { buildApp } from '../src/app.js';
import { FakePaymentsClient } from './fakes/fakePaymentsClient.js';
import { nairobiDayBounds } from '../src/routes/internal.js';
import type { Db } from '../src/db.js';

const SERVICE_TOKEN = 'test-service-token-0123456789abcdef';
const DAY = '2026-09-14';

async function app(db: Db) {
  return buildApp({
    db,
    paymentsClient: new FakePaymentsClient(),
    jwtSecret: 'test-secret',
    serviceToken: SERVICE_TOKEN,
    logger: false,
  });
}

function get(a: Awaited<ReturnType<typeof app>>, day = DAY, token: string | null = SERVICE_TOKEN) {
  return a.inject({
    method: 'GET',
    url: `/internal/daily-close?businessDay=${day}`,
    headers: token ? { 'x-service-token': token } : {},
  });
}

/** Insert a PAID sale directly, at a chosen paid_at instant. */
async function paidSale(
  db: Db,
  opts: { tenantId: string; attendantId: string; totalMinor: number; paidAt: string },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO sales (id, tenant_id, attendant_id, status, total_minor, paid_at)
     VALUES ($1, $2, $3, 'PAID', $4, $5)`,
    [id, opts.tenantId, opts.attendantId, opts.totalMinor, opts.paidAt],
  );
  return id;
}

describe('the Nairobi business day', () => {
  test('runs 21:00 UTC the previous day to 21:00 UTC — EAT is UTC+3 with no DST', () => {
    assert.deepEqual(nairobiDayBounds('2026-09-14'), {
      startUtc: '2026-09-13T21:00:00.000Z',
      endUtc: '2026-09-14T21:00:00.000Z',
    });
    // And across a month boundary.
    assert.equal(nairobiDayBounds('2026-10-01').startUtc, '2026-09-30T21:00:00.000Z');
  });

  test('a sale paid at 23:00 EAT belongs to that day, not the next UTC day', async () => {
    const { db } = createTestDb();
    const { tenant, attendant } = await seedTenant(db);
    await db.query(
      `INSERT INTO commission_rates (id, tenant_id, rate_bps, effective_from) VALUES ($1, $2, 500, '2026-01-01T00:00:00Z')`,
      [randomUUID(), tenant.id],
    );
    // 2026-09-14 23:00 EAT == 2026-09-14 20:00 UTC.
    await paidSale(db, {
      tenantId: tenant.id,
      attendantId: attendant.id,
      totalMinor: 10_000,
      paidAt: '2026-09-14T20:00:00.000Z',
    });

    const a = await app(db);
    const res = await get(a);
    assert.equal(res.json().tenants[0].attendants[0].sales.length, 1);
    await a.close();
  });

  test('a sale paid at 00:30 EAT the next day is excluded', async () => {
    const { db } = createTestDb();
    const { tenant, attendant } = await seedTenant(db);
    await db.query(
      `INSERT INTO commission_rates (id, tenant_id, rate_bps, effective_from) VALUES ($1, $2, 500, '2026-01-01T00:00:00Z')`,
      [randomUUID(), tenant.id],
    );
    // 2026-09-15 00:30 EAT == 2026-09-14 21:30 UTC — past the boundary.
    await paidSale(db, {
      tenantId: tenant.id,
      attendantId: attendant.id,
      totalMinor: 10_000,
      paidAt: '2026-09-14T21:30:00.000Z',
    });

    const a = await app(db);
    const res = await get(a);
    assert.deepEqual(res.json().tenants, [], 'it belongs to the 15th, not the 14th');
    await a.close();
  });
});

describe('only confirmed paid sales count', () => {
  test('UNPAID and VOID sales are excluded; PAID sales are included', async () => {
    const { db } = createTestDb();
    const { tenant, attendant } = await seedTenant(db);
    await db.query(
      `INSERT INTO commission_rates (id, tenant_id, rate_bps, effective_from) VALUES ($1, $2, 500, '2026-01-01T00:00:00Z')`,
      [randomUUID(), tenant.id],
    );
    const paidAt = '2026-09-14T10:00:00.000Z';
    await paidSale(db, { tenantId: tenant.id, attendantId: attendant.id, totalMinor: 10_000, paidAt });
    for (const status of ['UNPAID', 'VOID']) {
      await db.query(
        `INSERT INTO sales (id, tenant_id, attendant_id, status, total_minor, paid_at)
         VALUES ($1, $2, $3, $4, 50000, $5)`,
        [randomUUID(), tenant.id, attendant.id, status, paidAt],
      );
    }

    const a = await app(db);
    const sales = (await get(a)).json().tenants[0].attendants[0].sales;
    assert.equal(sales.length, 1);
    assert.equal(sales[0].totalMinor, 10_000);
    await a.close();
  });
});

describe('per-sale amounts, not an aggregate', () => {
  test('each sale is listed individually so the per-sale rounding rule can be applied', async () => {
    const { db } = createTestDb();
    const { tenant, attendant } = await seedTenant(db);
    await db.query(
      `INSERT INTO commission_rates (id, tenant_id, rate_bps, effective_from) VALUES ($1, $2, 500, '2026-01-01T00:00:00Z')`,
      [randomUUID(), tenant.id],
    );
    const paidAt = '2026-09-14T10:00:00.000Z';
    for (const total of [10_050, 10_050, 10_050]) {
      await paidSale(db, { tenantId: tenant.id, attendantId: attendant.id, totalMinor: total, paidAt });
    }

    const a = await app(db);
    const att = (await get(a)).json().tenants[0].attendants[0];
    assert.equal(att.sales.length, 3, 'three separate amounts, not one sum');

    // This is why: per-sale flooring gives 1506, aggregate flooring 1507.
    const perSale = att.sales.reduce(
      (acc: number, s: { totalMinor: number }) => acc + Math.floor((s.totalMinor * att.rateBps) / 10_000),
      0,
    );
    const aggregate = Math.floor(
      (att.sales.reduce((acc: number, s: { totalMinor: number }) => acc + s.totalMinor, 0) * att.rateBps) / 10_000,
    );
    assert.equal(perSale, 1506);
    assert.equal(aggregate, 1507);
    await a.close();
  });
});

describe('rates and MSISDNs', () => {
  test('an attendant-specific rate beats the tenant default', async () => {
    const { db } = createTestDb();
    const { tenant, attendant } = await seedTenant(db);
    await db.query(
      `INSERT INTO commission_rates (id, tenant_id, rate_bps, effective_from) VALUES ($1, $2, 500, '2026-01-01T00:00:00Z')`,
      [randomUUID(), tenant.id],
    );
    await db.query(
      `INSERT INTO commission_rates (id, tenant_id, attendant_id, rate_bps, effective_from) VALUES ($1, $2, $3, 750, '2026-01-01T00:00:00Z')`,
      [randomUUID(), tenant.id, attendant.id],
    );
    await paidSale(db, {
      tenantId: tenant.id,
      attendantId: attendant.id,
      totalMinor: 10_000,
      paidAt: '2026-09-14T10:00:00.000Z',
    });

    const a = await app(db);
    const att = (await get(a)).json().tenants[0].attendants[0];
    assert.equal(att.rateBps, 750);
    assert.equal(att.msisdn, '254700000000', 'the payout destination comes from the attendant record');
    await a.close();
  });

  test('a rate that takes effect AFTER the close does not apply to it', async () => {
    const { db } = createTestDb();
    const { tenant, attendant } = await seedTenant(db);
    await db.query(
      `INSERT INTO commission_rates (id, tenant_id, rate_bps, effective_from) VALUES ($1, $2, 500, '2026-01-01T00:00:00Z')`,
      [randomUUID(), tenant.id],
    );
    // An owner raises the rate a week later; the 14th still closes at 5%.
    await db.query(
      `INSERT INTO commission_rates (id, tenant_id, rate_bps, effective_from) VALUES ($1, $2, 900, '2026-09-21T00:00:00Z')`,
      [randomUUID(), tenant.id],
    );
    await paidSale(db, {
      tenantId: tenant.id,
      attendantId: attendant.id,
      totalMinor: 10_000,
      paidAt: '2026-09-14T10:00:00.000Z',
    });

    const a = await app(db);
    assert.equal((await get(a)).json().tenants[0].attendants[0].rateBps, 500);
    await a.close();
  });

  test('no configured rate means zero commission, not a crash', async () => {
    const { db } = createTestDb();
    const { tenant, attendant } = await seedTenant(db);
    await paidSale(db, {
      tenantId: tenant.id,
      attendantId: attendant.id,
      totalMinor: 10_000,
      paidAt: '2026-09-14T10:00:00.000Z',
    });

    const a = await app(db);
    const res = await get(a);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().tenants[0].attendants[0].rateBps, 0);
    await a.close();
  });
});

describe('tenant isolation and auth', () => {
  test('every tenant appears separately; no tenant sees another\'s sales', async () => {
    const { db } = createTestDb();
    // Two independent tenants. `users` is UNIQUE(tenant_id, external_auth_id),
    // so the same auth id in both tenants is legitimate.
    const one = await seedTenant(db);
    const two = await seedTenant(db);
    const paidAt = '2026-09-14T10:00:00.000Z';
    for (const t of [one, two]) {
      await db.query(
        `INSERT INTO commission_rates (id, tenant_id, rate_bps, effective_from) VALUES ($1, $2, 500, '2026-01-01T00:00:00Z')`,
        [randomUUID(), t.tenant.id],
      );
      await paidSale(db, { tenantId: t.tenant.id, attendantId: t.attendant.id, totalMinor: 10_000, paidAt });
    }

    const a = await app(db);
    const tenants = (await get(a)).json().tenants;
    assert.equal(tenants.length, 2);
    for (const t of tenants) {
      assert.equal(t.attendants.length, 1, 'each tenant carries only its own attendant');
    }
    await a.close();
  });

  test('the endpoint requires the service token and a valid businessDay', async () => {
    const { db } = createTestDb();
    const a = await app(db);

    assert.equal((await get(a, DAY, null)).statusCode, 401);
    assert.equal((await get(a, DAY, 'wrong-token-xxxxxxxxxxxxxxxxx')).statusCode, 401);
    assert.equal((await get(a, '14-09-2026')).statusCode, 400);
    assert.equal((await get(a, 'yesterday')).statusCode, 400);

    const ok = await get(a);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json().windowUtc, { start: '2026-09-13T21:00:00.000Z', end: '2026-09-14T21:00:00.000Z' });
    await a.close();
  });

  test('a day with no paid sales returns an empty tenant list, not an error', async () => {
    const { db } = createTestDb();
    await seedTenant(db);
    const a = await app(db);
    const res = await get(a, '2026-01-01');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().tenants, []);
    await a.close();
  });
});
