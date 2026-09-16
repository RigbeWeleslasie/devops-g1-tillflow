/**
 * A fresh in-memory Postgres (pg-mem) per test, loaded with the real
 * migrations/*.sql — the same SQL that runs against RDS. If a migration
 * doesn't work here, it wouldn't work for real either. Same helper shape as
 * services/pos/test/testDb.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb, DataType, type IMemoryDb } from 'pg-mem';
import type { Db } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

export function createTestDb(): { db: Db; mem: IMemoryDb } {
  const mem = newDb({ autoCreateForeignKeyIndices: true });

  // pg-mem lacks the `%` operator and the built-in mod(). The schema's
  // whole-shilling CHECKs use mod(x, 100) — a Postgres built-in — so the
  // real constraint stays in the SQL and only the test engine needs this.
  mem.public.registerFunction({
    name: 'mod',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: (a: number, b: number) => a % b,
  });

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    mem.public.none(sql);
  }

  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();
  return { db: pool as unknown as Db, mem };
}
