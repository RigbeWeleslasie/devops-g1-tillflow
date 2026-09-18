/**
 * The schema's own guarantees, proven at the database layer directly —
 * bypassing tenantService/saleService entirely — so a bug (or a deleted
 * migration) in the application layer can't hide a missing constraint.
 * Same pattern as services/payments/test/schema.test.ts.
 *
 * Concretely: tenantService.createProduct already rejects a fractional
 * price before the INSERT runs, so every existing test that goes through
 * the normal API surface would keep passing even if
 * migrations/002_whole_shilling_prices.sql vanished entirely — confirmed
 * by deleting that file and re-running the suite (docs/scar-log.md,
 * 2026-09-17). These tests insert straight through db.query, so only the
 * DB constraint itself can save them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './testDb.js';
import { seedTenant } from './fixtures.js';
import { createSale } from '../src/services/saleService.js';

test('products: a raw insert with a fractional-shilling price is rejected at the DB layer', async () => {
  const { db } = createTestDb();
  const { tenant } = await seedTenant(db);

  await assert.rejects(
    db.query(
      'INSERT INTO products (id, tenant_id, name, unit_price_minor) VALUES ($1, $2, $3, $4)',
      [randomUUID(), tenant.id, 'Bypassed product', 10_050],
    ),
    /check|constraint/i,
  );
});

test('sale_items: a raw insert with a fractional-shilling price is rejected at the DB layer', async () => {
  const { db } = createTestDb();
  const { tenant, attendant, product } = await seedTenant(db);

  // A real sale, through the normal (tested, whole-shillings) path -- gives
  // a valid sale_id/product_id to attach the bypassing row to, without that
  // setup itself being what's under test here.
  const { body: sale } = await createSale(
    db,
    tenant.id,
    attendant.id,
    [{ productId: product.id, quantity: 1 }],
    randomUUID(),
  );

  await assert.rejects(
    db.query(
      'INSERT INTO sale_items (id, sale_id, product_id, quantity, unit_price_minor) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), sale.id, product.id, 1, 10_050],
    ),
    /check|constraint/i,
  );
});
