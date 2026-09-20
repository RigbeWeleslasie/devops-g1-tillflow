/**
 * App factory — separated from server.ts so tests build a fully wired
 * Fastify instance with an injected pg-mem db and a FakeAdapter, and drive
 * it with `.inject()` — no socket, no AWS, no network.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { trace } from '@opentelemetry/api';
import { healthPlugin } from '@tillflow/shared/health';
import { routePrefixRewrite } from '@tillflow/shared/routePrefix';
import { serviceAuthPlugin } from '@tillflow/shared/serviceAuth';
import type { MpesaAdapter } from '@tillflow/mpesa';
import type { Db } from './db.js';
import chargesRoutes from './routes/charges.js';
import callbacksRoutes from './routes/callbacks.js';
import payoutsRoutes from './routes/payouts.js';
import adminRoutes from './routes/admin.js';

export interface BuildAppOptions {
  db: Db;
  adapter: MpesaAdapter;
  serviceToken: string;
  callbackBaseUrl: string;
  reconcileAfterMs?: number;
  reconcileMaxAttempts?: number;
  /**
   * The clock, injected like db and adapter. Every timestamp this service
   * writes and every window it evaluates goes through here, so a test can
   * drive "two minutes later" deterministically instead of sleeping — and so
   * created_at and the reconcile cutoff can never come from different clocks.
   */
  now?: () => Date;
  /**
   * Confirm a success callback against Daraja before marking a charge PAID.
   * Defaults on. See ApplyOptions.confirmBeforePaid for why the off switch
   * exists and what turning it off costs.
   */
  confirmBeforePaid?: boolean;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const now = opts.now ?? (() => new Date());
  const app = Fastify({
    // The edge forwards `/payments/...` and the rewritten `/callbacks/...`
    // unchanged; strip our prefix before routing. See
    // @tillflow/shared/routePrefix.
    rewriteUrl: routePrefixRewrite('payments'),
    logger:
      opts.logger === false
        ? false
        : {
            // The brief: JSON logs carry trace_id / span_id. Pino's mixin runs
            // per line and reads the active OTel span, so every log line from
            // a request can be joined to its trace in Grafana.
            mixin() {
              const ctx = trace.getActiveSpan()?.spanContext();
              return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
            },
            redact: ['req.headers.authorization', 'req.headers["x-service-token"]'],
          },
  });

  await app.register(sensible);
  await app.register(healthPlugin, {
    serviceName: 'payments',
    // Readiness means "can serve a charge", which means the DB answers.
    checkReady: async () => {
      try {
        await opts.db.query('SELECT 1');
        return { ready: true };
      } catch (err) {
        return { ready: false, reason: err instanceof Error ? err.message : 'db unreachable' };
      }
    },
  });
  await app.register(serviceAuthPlugin, { serviceToken: opts.serviceToken });
  await app.register(chargesRoutes, {
    db: opts.db,
    adapter: opts.adapter,
    callbackBaseUrl: opts.callbackBaseUrl,
    now,
  });
  await app.register(payoutsRoutes, {
    db: opts.db,
    adapter: opts.adapter,
    callbackBaseUrl: opts.callbackBaseUrl,
    now,
  });
  await app.register(callbacksRoutes, {
    db: opts.db,
    now,
    // The confirming query (G5): a success callback is a notification, not
    // evidence. Payments asks Daraja directly before any PAID transition.
    adapter: opts.adapter,
    ...(opts.confirmBeforePaid !== undefined ? { confirmBeforePaid: opts.confirmBeforePaid } : {}),
  });
  await app.register(adminRoutes, {
    db: opts.db,
    adapter: opts.adapter,
    reconcileAfterMs: opts.reconcileAfterMs ?? 2 * 60_000,
    reconcileMaxAttempts: opts.reconcileMaxAttempts ?? 12,
    now,
  });

  return app;
}
