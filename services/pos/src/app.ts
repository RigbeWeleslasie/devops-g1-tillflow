/**
 * App factory — separated from server.ts so tests can build a fully wired
 * Fastify instance with an injected (pg-mem-backed) db and a fake payments
 * client, using `.inject()` instead of a real listening socket.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { healthPlugin } from '@tillflow/shared/health';
import { routePrefixRewrite } from '@tillflow/shared/routePrefix';
import { serviceAuthPlugin } from '@tillflow/shared/serviceAuth';
import type { Db } from './db.js';
import type { PaymentsClient } from './services/paymentsClient.js';
import authPlugin from './plugins/auth.js';
import tenantRoutes from './routes/tenants.js';
import salesRoutes from './routes/sales.js';
import internalRoutes from './routes/internal.js';

export interface BuildAppOptions {
  db: Db;
  paymentsClient: PaymentsClient;
  jwtSecret: string;
  /** Shared secret for the Commission worker's internal read API. */
  serviceToken: string;
  devAuthEnabled?: boolean;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? true,
    // The edge forwards `/pos/...` unchanged; strip it before routing so no
    // route has to know the prefix exists. See @tillflow/shared/routePrefix.
    rewriteUrl: routePrefixRewrite('pos'),
  });

  await app.register(sensible);
  await app.register(healthPlugin, { serviceName: 'pos' });
  await app.register(authPlugin, {
    jwtSecret: opts.jwtSecret,
    db: opts.db,
    ...(opts.devAuthEnabled !== undefined ? { devAuthEnabled: opts.devAuthEnabled } : {}),
  });
  await app.register(tenantRoutes, { db: opts.db });
  await app.register(salesRoutes, { db: opts.db, paymentsClient: opts.paymentsClient });
  await app.register(serviceAuthPlugin, { serviceToken: opts.serviceToken });
  await app.register(internalRoutes, { db: opts.db });

  return app;
}
