/**
 * DB access. Business logic (src/services/*) takes a `Db` as a constructor
 * argument rather than importing a singleton pool — that's what lets tests
 * hand it a pg-mem-backed pool with the exact same shape as the real one,
 * and it's real `pg`, not a hand-rolled subset, so nothing behaves
 * differently in a test than it will against RDS.
 */
import pg from 'pg';

export type Db = Pick<pg.Pool, 'query' | 'connect'>;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

/**
 * Run `fn` inside a transaction. Every write path that touches more than one
 * table (sale + line items + idempotency key; sale + paid-event dedupe) goes
 * through this — the guarantee I1/I3 depend on is "all of it commits, or
 * none of it does".
 */
export async function withTransaction<T>(
  db: Db,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

/** Postgres unique_violation. Both pg (real) and pg-mem (test) set this code. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
