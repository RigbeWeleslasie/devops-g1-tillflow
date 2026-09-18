/**
 * Wires the REAL POS and Payments services together, with only Daraja faked.
 *
 * Why this exists: every other suite in the repo fakes the service boundary
 * it depends on. POS tests use a FakePaymentsClient; Commission tests use a
 * FakePosClient and a FakePaymentsClient. Each side therefore passes against
 * its OWN idea of the contract, and a mismatch between the two is invisible —
 * which is exactly how the `tenantId` / `customerMsisdn` gap survived.
 *
 * Here, nothing between POS and Payments is faked:
 *
 *   POS  --HTTP(inject)-->  Payments  --FakeAdapter-->  "Daraja"
 *    ^                          |
 *    |                          v
 *    +---- sale.paid <---- outbox relay
 *
 * Only two things are stand-ins, and both are genuinely external:
 *   - the M-Pesa provider (FakeAdapter, ADR 0005)
 *   - SQS (an in-process queue; the real one is at-least-once, which the
 *     consumer already absorbs)
 *
 * Two separate pg-mem databases, because POS and Payments own separate
 * schemas with separate least-privilege roles in production. A test that
 * shared one database would hide a cross-schema read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb, DataType } from 'pg-mem';
import type { FastifyInstance } from 'fastify';
import { FakeAdapter, type PendingCallback } from '@tillflow/mpesa';
import type { SalePaidEvent } from '@tillflow/shared/events';

import { buildApp as buildPosApp } from '@tillflow/pos/dist/app.js';
import { buildApp as buildPaymentsApp } from '@tillflow/payments/dist/app.js';
import { relayOnce } from '@tillflow/payments/dist/services/outbox.js';
import { runOnce as runSalePaidConsumer } from '@tillflow/pos/dist/workers/salePaidConsumer.js';
import { FakeEventSource } from '@tillflow/pos/dist/workers/fakeEventSource.js';
import type {
  PaymentsClient,
  CreateChargeRequest,
  CreateChargeResult,
} from '@tillflow/pos/dist/services/paymentsClient.js';
import { runClose, type CloseResult } from '@tillflow/commission/dist/services/closeService.js';
import { HttpPosClient } from '@tillflow/commission/dist/clients/posClient.js';
import { HttpPaymentsClient } from '@tillflow/commission/dist/clients/paymentsClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..', '..');

export const SERVICE_TOKEN = 'integration-service-token-0123456789';
const CALLBACK_BASE = 'http://payments.test';

function loadDb(migrationsDir: string) {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({
    name: 'mod',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: (a: number, b: number) => a % b,
  });
  for (const f of fs.readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
    mem.public.none(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  const adapter = mem.adapters.createPg();
  return new adapter.Pool();
}

/**
 * A `fetch` that dials a Fastify app in-process.
 *
 * This is what lets Commission's REAL HttpPosClient and HttpPaymentsClient run
 * against the REAL POS and Payments routes. Both clients take an injectable
 * `fetchImpl`, so nothing in the client is stubbed: the service token header,
 * the status-code vocabulary, the JSON parsing and the error branches are all
 * the production code paths. Only the socket is replaced.
 */
function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body === undefined || init.body === null
        ? {}
        : { payload: init.body as string }),
    });

    // 204/304 must not carry a body, or the Response constructor throws.
    const body = res.statusCode === 204 || res.statusCode === 304 ? null : res.rawPayload;
    const contentType = res.headers['content-type'];
    return new Response(body, {
      status: res.statusCode,
      headers: typeof contentType === 'string' ? { 'content-type': contentType } : {},
    });
  }) as typeof fetch;
}

/**
 * POS's PaymentsClient, implemented by actually calling the Payments service.
 * This is THE seam under test: the body POS builds is the body Payments
 * validates, with no fake in between.
 *
 * It mirrors the real HttpPaymentsClient's failure vocabulary exactly — any
 * non-2xx becomes `unknown`, never a decline — so a contract mismatch shows
 * up the way it would in production: as an uncertain payment, not an error.
 */
class InjectedPaymentsClient implements PaymentsClient {
  readonly requests: CreateChargeRequest[] = [];
  readonly responses: Array<{ status: number; body: string }> = [];

  constructor(private readonly payments: FastifyInstance) {}

  async createCharge(req: CreateChargeRequest): Promise<CreateChargeResult> {
    this.requests.push(req);
    const res = await this.payments.inject({
      method: 'POST',
      url: '/charges',
      headers: { 'x-service-token': SERVICE_TOKEN },
      payload: req as unknown as Record<string, unknown>,
    });
    this.responses.push({ status: res.statusCode, body: res.body });
    if (res.statusCode >= 400) return { outcome: 'unknown' };
    const body = res.json() as { chargeId: string };
    return { outcome: 'accepted', chargeId: body.chargeId, status: 'PENDING' };
  }
}

export interface Stack {
  pos: FastifyInstance;
  payments: FastifyInstance;
  posDb: ReturnType<typeof loadDb>;
  paymentsDb: ReturnType<typeof loadDb>;
  fake: FakeAdapter;
  /** Every POS -> Payments exchange, for asserting on the seam itself. */
  seam: InjectedPaymentsClient;
  /** Deliver queued M-Pesa callbacks into the real Payments callback route. */
  deliverCallbacks: (opts?: { order?: 'fifo' | 'reverse' }) => Promise<number>;
  /** Publish outbox rows to the queue, then let POS consume them. */
  pump: () => Promise<{ published: number; consumed: number }>;
  /**
   * Run Commission's daily close across the real seam: its own HTTP clients
   * read POS's /internal/daily-close and POST Payments' /payouts for real.
   */
  runDailyClose: (businessDay: string) => Promise<CloseResult>;
  now: () => number;
  advance: (ms: number) => void;
  close: () => Promise<void>;
}

export async function startStack(opts: { startMs?: number } = {}): Promise<Stack> {
  let nowMs = opts.startMs ?? Date.parse('2026-09-16T10:00:00Z');
  const now = () => new Date(nowMs);

  const posDb = loadDb(path.join(REPO, 'services', 'pos', 'migrations'));
  const paymentsDb = loadDb(path.join(REPO, 'services', 'payments', 'migrations'));

  let payments!: FastifyInstance;
  const fake = new FakeAdapter({
    clock: () => nowMs,
    seed: 1,
    deliver: async (cb: PendingCallback) => {
      const res = await payments.inject({
        method: 'POST',
        url: new URL(cb.url).pathname,
        payload: cb.body as unknown as Record<string, unknown>,
      });
      if (res.statusCode >= 500) throw new Error(`callback -> ${res.statusCode}: ${res.body}`);
    },
  });

  payments = await buildPaymentsApp({
    db: paymentsDb,
    adapter: fake,
    serviceToken: SERVICE_TOKEN,
    callbackBaseUrl: CALLBACK_BASE,
    now,
    logger: false,
  });

  const seam = new InjectedPaymentsClient(payments);
  const pos = await buildPosApp({
    db: posDb,
    paymentsClient: seam,
    jwtSecret: 'integration-jwt-secret',
    serviceToken: SERVICE_TOKEN,
    logger: false,
    // Explicit opt-in, same as the sandbox's real infra grant
    // (infra/service-mesh.tf) -- DEV_AUTH_ENABLED now defaults to off
    // (docs/scar-log.md), and this harness's POST /dev/tokens calls below
    // need the route mounted.
    devAuthEnabled: true,
  });

  // Stands in for devops-g1-sale-events. The real queue is at-least-once;
  // POS's consumer is idempotent on saleId, which this lets us exercise.
  const queue = new FakeEventSource();

  return {
    pos,
    payments,
    posDb,
    paymentsDb,
    fake,
    seam,
    deliverCallbacks: (o = {}) => fake.deliverPending(o),
    async pump() {
      const relay = await relayOnce({
        db: paymentsDb,
        publisher: { publish: async (e: SalePaidEvent) => queue.publish(e) },
        now,
      });
      const consumed = await runSalePaidConsumer({ db: posDb, source: queue });
      return { published: relay.published, consumed };
    },
    // Commission shares the payments schema and role (ADR 0003), so it reads
    // and writes `paymentsDb` — the same database Payments itself uses, which
    // is exactly the production arrangement.
    runDailyClose: (businessDay) =>
      runClose(businessDay, {
        db: paymentsDb,
        pos: new HttpPosClient({
          baseUrl: 'http://pos.test',
          serviceToken: SERVICE_TOKEN,
          fetchImpl: injectFetch(pos),
        }),
        payments: new HttpPaymentsClient({
          baseUrl: CALLBACK_BASE,
          serviceToken: SERVICE_TOKEN,
          fetchImpl: injectFetch(payments),
        }),
        now,
      }),
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
    async close() {
      await pos.close();
      await payments.close();
    },
  };
}

/** Seed a tenant, owner, attendant and product through POS's real API. */
export async function seedTenantViaApi(
  stack: Stack,
  opts: { unitPriceMinor?: number; rateBps?: number } = {},
): Promise<{ tenantId: string; attendantId: string; productId: string; token: string }> {
  const created = await stack.pos.inject({
    method: 'POST',
    url: '/tenants',
    payload: {
      name: 'Integration Shop',
      tillNumber: '174379',
      ownerExternalAuthId: 'owner-1',
      ownerDisplayName: 'Owner',
    },
  });
  const { tenant } = created.json() as { tenant: { id: string } };

  const ownerToken = (
    await stack.pos.inject({
      method: 'POST',
      url: '/dev/tokens',
      payload: { tenantId: tenant.id, externalAuthId: 'owner-1' },
    })
  ).json().token as string;

  const auth = { authorization: `Bearer ${ownerToken}` };

  const attendant = (
    await stack.pos.inject({
      method: 'POST',
      url: `/tenants/${tenant.id}/attendants`,
      headers: auth,
      payload: { externalAuthId: 'att-1', displayName: 'Attendant', msisdn: '254700000000' },
    })
  ).json() as { id: string };

  // Whole shillings: M-Pesa cannot carry cents, and both adapters refuse a
  // fractional amount rather than rounding it.
  const product = (
    await stack.pos.inject({
      method: 'POST',
      url: `/tenants/${tenant.id}/products`,
      headers: auth,
      payload: { name: 'Widget', unitPriceMinor: opts.unitPriceMinor ?? 25_000 },
    })
  ).json() as { id: string };

  await stack.pos.inject({
    method: 'POST',
    url: `/tenants/${tenant.id}/rates`,
    headers: auth,
    payload: { rateBps: opts.rateBps ?? 500 },
  });

  // POS has no injectable clock (Payments does), so `commission_rates.
  // effective_from` defaults to the DATABASE's now() -- the real wall clock --
  // while every timestamp this harness controls comes from the frozen clock.
  // The rate would therefore be stamped AFTER the sale it is meant to govern,
  // and `internal.ts` resolves rates with `effective_from < paid_at`, so the
  // close would silently compute 0% for every attendant.
  //
  // Backdated here rather than worked around in each test: the ordering being
  // asserted is "the rate was in force when the sale happened", which is a
  // property of the scenario, not of when the row was physically inserted.
  await stack.posDb.query(
    `UPDATE commission_rates SET effective_from = $1 WHERE tenant_id = $2`,
    [new Date(stack.now() - 86_400_000).toISOString(), tenant.id],
  );

  const attendantToken = (
    await stack.pos.inject({
      method: 'POST',
      url: '/dev/tokens',
      payload: { tenantId: tenant.id, externalAuthId: 'att-1' },
    })
  ).json().token as string;

  return { tenantId: tenant.id, attendantId: attendant.id, productId: product.id, token: attendantToken };
}
