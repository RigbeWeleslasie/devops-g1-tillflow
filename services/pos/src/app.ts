/**
 * App factory — separated from server.ts so tests can build a fully wired
 * Fastify instance with an injected (pg-mem-backed) db and a fake payments
 * client, using `.inject()` instead of a real listening socket.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { healthPlugin } from '@tillflow/shared/health';
import type { Db } from './db.js';
import type { PaymentsClient } from './services/paymentsClient.js';
import authPlugin from './plugins/auth.js';
import tenantRoutes from './routes/tenants.js';
import salesRoutes from './routes/sales.js';

export interface BuildAppOptions {
  db: Db;
  paymentsClient: PaymentsClient;
  jwtSecret: string;
  devAuthEnabled?: boolean;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  await app.register(sensible);
  await app.register(healthPlugin, { serviceName: 'pos' });
  await app.register(authPlugin, {
    jwtSecret: opts.jwtSecret,
    db: opts.db,
    ...(opts.devAuthEnabled !== undefined ? { devAuthEnabled: opts.devAuthEnabled } : {}),
  });
  await app.register(tenantRoutes, { db: opts.db });
  await app.register(salesRoutes, { db: opts.db, paymentsClient: opts.paymentsClient });

  return app;
}
