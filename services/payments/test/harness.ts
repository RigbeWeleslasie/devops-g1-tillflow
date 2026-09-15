/**
 * One fully wired Payments app per test: pg-mem loaded with the real
 * migrations, a FakeAdapter whose callbacks route straight back into the
 * app via `inject` (no socket), a controllable clock, and the service token.
 *
 * `fake.deliverPending()` therefore runs the REAL callback route — dedupe,
 * guarded transition, outbox row — exactly as Daraja's POST would.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { FakeAdapter, type PendingCallback } from '@tillflow/mpesa';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import { createTestDb } from './testDb.js';

export const SERVICE_TOKEN = 'test-service-token-0123456789abcdef';
export const CALLBACK_BASE = 'http://payments.test';

/**
 * Reconcile settings the harness and the tests BOTH use. Exported so a test
 * can never assert against a threshold the app under test isn't using — the
 * mistake that made /admin/pending look broken when it wasn't.
 */
export const RECONCILE_AFTER_MS = 2 * 60_000;
export const RECONCILE_MAX_ATTEMPTS = 3;

export interface Harness {
  app: FastifyInstance;
  db: Db;
  fake: FakeAdapter;
  now: () => number;
  nowDate: () => Date;
  advance: (ms: number) => void;
  /** inject() with the service token already set. */
  call: (opts: InjectOptions) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

export async function createHarness(opts: { startMs?: number } = {}): Promise<Harness> {
  let nowMs = opts.startMs ?? Date.parse('2026-09-15T10:00:00Z');
  const { db } = createTestDb();

  // Declared before the app so the closure can capture it; assigned after.
  let app!: FastifyInstance;
  const fake = new FakeAdapter({
    clock: () => nowMs,
    seed: 1,
    deliver: async (cb: PendingCallback) => {
      const path = new URL(cb.url).pathname;
      const res = await app.inject({ method: 'POST', url: path, payload: cb.body });
      if (res.statusCode >= 500) throw new Error(`callback ${path} -> HTTP ${res.statusCode}: ${res.body}`);
    },
  });

  app = await buildApp({
    db,
    adapter: fake,
    serviceToken: SERVICE_TOKEN,
    callbackBaseUrl: CALLBACK_BASE,
    reconcileAfterMs: RECONCILE_AFTER_MS,
    reconcileMaxAttempts: RECONCILE_MAX_ATTEMPTS,
    // The same clock the fake adapter uses, so created_at, the reconcile
    // cutoff and the fake's callback delays all move together under
    // h.advance(). Without this the service stamps rows with the wall clock
    // and no time-dependent behaviour is testable.
    now: () => new Date(nowMs),
    logger: false,
  });

  return {
    app,
    db,
    fake,
    now: () => nowMs,
    nowDate: () => new Date(nowMs),
    advance: (ms) => {
      nowMs += ms;
    },
    call: (o) => {
      // Build the options as an explicitly typed value: inject() is
      // overloaded, and a spread literal makes TS pick the chainable
      // (no-argument) overload instead of the Promise-returning one.
      const withToken: InjectOptions = {
        ...o,
        headers: { 'x-service-token': SERVICE_TOKEN, ...(o.headers ?? {}) },
      };
      return app.inject(withToken);
    },
    close: () => app.close(),
  };
}

/** A valid POST /charges body. Amount defaults to KES 250 (scenario: success). */
export function chargeBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    saleId: randomUUID(),
    tenantId: randomUUID(),
    amountMinor: 25_000,
    tenantTill: '174379',
    customerMsisdn: '254708374149',
    ...overrides,
  };
}

export async function countRows(db: Db, table: string, where = '', params: unknown[] = []): Promise<number> {
  const res = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} ${where}`, params);
  return res.rows[0]?.n ?? 0;
}
