/**
 * A fresh in-memory Postgres (pg-mem) per test, loaded with the real
 * migrations/*.sql files — the same SQL that runs against RDS, not a
 * hand-simplified test schema. If a migration doesn't work here, it
 * wouldn't work for real either.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb, type IMemoryDb } from 'pg-mem';
import type { Db } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

export function createTestDb(): { db: Db; mem: IMemoryDb } {
  const mem = newDb({ autoCreateForeignKeyIndices: true });

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
