/**
 * App factory — separated from server.ts so tests build a fully wired
 * Fastify instance with an injected pg-mem db and a FakeAdapter, and drive
 * it with `.inject()` — no socket, no AWS, no network.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { trace } from '@opentelemetry/api';
import { healthPlugin } from '@tillflow/shared/health';
import type { MpesaAdapter } from '@tillflow/mpesa';
import type { Db } from './db.js';
import serviceAuthPlugin from './plugins/serviceAuth.js';
import chargesRoutes from './routes/charges.js';
import callbacksRoutes from './routes/callbacks.js';

export interface BuildAppOptions {
  db: Db;
  adapter: MpesaAdapter;
  serviceToken: string;
  callbackBaseUrl: string;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
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
  });
  await app.register(callbacksRoutes, { db: opts.db });

  return app;
}
