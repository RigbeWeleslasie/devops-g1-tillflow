/**
 * POST /admin/charges/purge-abandoned — delete charges that are PENDING with no
 * CheckoutRequestID (the push never got a reference, so no callback can ever
 * match and no money moved). Dry run by default; never touches a held charge, a
 * charge with a reference, a terminal charge, or one newer than the cutoff.
 *
 * Exists because a load test can leave thousands of these, starving the
 * reconciler and swamping /admin/pending (docs/scar-log.md 2026-09-29).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHarness, countRows, type Harness } from './harness.js';

const PURGE = '/admin/charges/purge-abandoned';

interface SeedOpts {
  status?: 'PENDING' | 'PAID' | 'FAILED';
  checkoutRequestId?: string | null;
  holdReason?: string | null;
  tenantId?: string;
  ageMinutes?: number; // how far before "now" the charge was created
}

async function seed(h: Harness, o: SeedOpts = {}): Promise<string> {
  const id = randomUUID();
  const createdAt = new Date(h.now() - (o.ageMinutes ?? 120) * 60_000).toISOString();
  await h.db.query(
    `INSERT INTO charges
       (id, sale_id, tenant_id, amount_minor, till, customer_msisdn, status,
        checkout_request_id, hold_reason, created_at, updated_at)
     VALUES ($1, $2, $3, 10300, '174379', '254708374149', $4, $5, $6, $7, $7)`,
    [
      id,
      randomUUID(),
      o.tenantId ?? randomUUID(),
      o.status ?? 'PENDING',
      o.checkoutRequestId ?? null,
      o.holdReason ?? null,
      createdAt,
    ],
  );
  return id;
}

describe('POST /admin/charges/purge-abandoned', () => {
  test('dry run (the default) reports the count and deletes nothing', async () => {
    const h = await createHarness();
    await seed(h); // abandoned, old
    await seed(h); // abandoned, old
    await seed(h, { checkoutRequestId: `ws_${randomUUID()}` }); // has a reference — not abandoned
    await seed(h, { status: 'PAID' }); // terminal
    await seed(h, { holdReason: 'amount mismatch' }); // human-flagged
    await seed(h, { ageMinutes: 1 }); // too new

    const res = await h.call({ method: 'POST', url: PURGE, payload: {} });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.dryRun, true);
    assert.equal(body.wouldDelete, 2, 'only the two abandoned-and-old charges');
    assert.equal(body.sample.length, 2);
    assert.equal(await countRows(h.db, 'charges'), 6, 'nothing deleted on a dry run');
    await h.close();
  });

  test('dryRun:false deletes ONLY abandoned old charges; leaves everything else', async () => {
    const h = await createHarness();
    const doomed1 = await seed(h);
    const doomed2 = await seed(h);
    const withRef = await seed(h, { checkoutRequestId: `ws_${randomUUID()}` });
    const paid = await seed(h, { status: 'PAID' });
    const held = await seed(h, { holdReason: 'amount mismatch' });
    const fresh = await seed(h, { ageMinutes: 1 });

    const res = await h.call({ method: 'POST', url: PURGE, payload: { dryRun: false } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.dryRun, false);
    assert.equal(body.deleted, 2);

    const survivors = await h.db.query<{ id: string }>('SELECT id FROM charges ORDER BY created_at');
    const ids = survivors.rows.map((r) => r.id);
    assert.deepEqual(ids.sort(), [withRef, paid, held, fresh].sort(), 'the four protected charges remain');
    assert.ok(!ids.includes(doomed1) && !ids.includes(doomed2), 'both abandoned charges are gone');
    await h.close();
  });

  test('tenantIds narrows the purge to the given tenants only', async () => {
    const h = await createHarness();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await seed(h, { tenantId: tenantA });
    await seed(h, { tenantId: tenantA });
    const keep = await seed(h, { tenantId: tenantB });

    const res = await h.call({ method: 'POST', url: PURGE, payload: { dryRun: false, tenantIds: [tenantA] } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().deleted, 2);

    const rows = await h.db.query<{ id: string; tenant_id: string }>('SELECT id, tenant_id FROM charges');
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.id, keep);
    assert.equal(rows.rows[0]!.tenant_id, tenantB);
    await h.close();
  });

  test('rejects an age below the floor, deleting nothing', async () => {
    const h = await createHarness();
    await seed(h);
    const res = await h.call({ method: 'POST', url: PURGE, payload: { dryRun: false, olderThanMinutes: 1 } });
    assert.equal(res.statusCode, 400);
    assert.equal(await countRows(h.db, 'charges'), 1, 'a rejected request deletes nothing');
    await h.close();
  });

  test('401 without the service token', async () => {
    const h = await createHarness();
    const res = await h.app.inject({ method: 'POST', url: PURGE, payload: { dryRun: false } });
    assert.equal(res.statusCode, 401);
    await h.close();
  });
});
