import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './testDb.js';

test('migrations load into pg-mem and a basic insert/select round-trips', async () => {
  const { db } = createTestDb();
  const tenantId = randomUUID();
  await db.query('INSERT INTO tenants (id, name, till_number) VALUES ($1, $2, $3)', [
    tenantId,
    'Test Tenant',
    '123456',
  ]);
  const result = await db.query<{ id: string; name: string }>('SELECT id, name FROM tenants WHERE id = $1', [
    tenantId,
  ]);
  assert.equal(result.rows[0]?.name, 'Test Tenant');
});
