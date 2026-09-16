/**
 * DB access for the Commission worker.
 *
 * Commission shares the `payments` schema and the devops-g1-payments-app
 * role (docs/architecture.md §3: the payout ledger is an integrity concern
 * owned by Payments). It therefore uses the same migrations — there is no
 * separate commission schema — and this file mirrors
 * services/payments/src/db.ts so both read the ledger identically.
 */
import pg from 'pg';

export type Db = Pick<pg.Pool, 'query' | 'connect'>;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
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

/**
 * Did `INSERT ... ON CONFLICT DO NOTHING RETURNING id` actually insert?
 *
 * Never answer this from rowCount. Real Postgres returns zero rows on a
 * conflict; pg-mem returns ONE row — the pre-existing one — so rowCount is 1
 * either way there and a test would pass for the wrong reason. Comparing the
 * returned id to the id we tried to insert is correct on both engines:
 * a fresh insert echoes our id, a conflict echoes (pg-mem) or omits (Postgres)
 * someone else's.
 */
export function didInsert(result: { rows: Array<{ id: string }> }, attemptedId: string): boolean {
  return result.rows[0]?.id === attemptedId;
}

/**
 * Postgres advisory lock, held for the life of `fn`'s transaction. Used by
 * the reconciler and the outbox relay so that with two ECS tasks only one
 * runs a given loop at a time. Returns undefined if the lock is held
 * elsewhere (pg_try_advisory_xact_lock is non-blocking).
 *
 * pg-mem has no advisory locks; tests inject a Db whose query() answers the
 * lock probe, or drive the loop bodies directly.
 */
export async function withAdvisoryLock<T>(
  db: Db,
  lockKey: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T | undefined> {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [
      lockKey,
    ]);
    if (!res.rows[0]?.locked) return undefined;
    return fn(tx);
  });
}

/** Stable keys for pg_try_advisory_xact_lock — one per singleton loop. */
export const LOCK_KEY = {
  RECONCILER: 71_001,
  OUTBOX_RELAY: 71_002,
  DAILY_CLOSE: 71_003,
} as const;
