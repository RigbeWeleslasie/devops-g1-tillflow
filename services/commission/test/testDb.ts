/**
 * A fresh in-memory Postgres per test, loaded with the PAYMENTS migrations.
 * Commission has no schema of its own: the payout ledger lives in the
 * `payments` schema and is owned there (docs/architecture.md §3). Loading
 * the real files means a ledger constraint that would fail against RDS
 * fails here too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb, DataType, type IMemoryDb } from 'pg-mem';
import type { Db } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'payments', 'migrations');

export function createTestDb(): { db: Db; mem: IMemoryDb } {
  const mem = newDb({ autoCreateForeignKeyIndices: true });

  // pg-mem lacks mod(); the schema's whole-shilling CHECKs use it.
  mem.public.registerFunction({
    name: 'mod',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: (a: number, b: number) => a % b,
  });

  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    mem.public.none(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }

  const adapter = mem.adapters.createPg();
  return { db: new adapter.Pool() as unknown as Db, mem };
}
