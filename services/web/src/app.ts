import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import sensible from '@fastify/sensible';
import { healthPlugin } from '@tillflow/shared/health';
import pagesRoutes from './routes/pages.js';

export interface BuildAppOptions {
  posBaseUrl: string;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  await app.register(sensible);
  await app.register(cookie);
  // Every form in views.ts submits application/x-www-form-urlencoded (the
  // HTML default), not JSON. Without this, Fastify's default body parser
  // only understands application/json and rejects every real browser form
  // POST with 415 before the route handler ever runs -- app.inject({
  // payload }) in the test suite sends JSON, which is why this went
  // unnoticed: every test passed while the UI never actually worked.
  await app.register(formbody);
  await app.register(healthPlugin, {
    serviceName: 'web',
    // web has no DB of its own; readiness is "can I reach POS" once there's
    // a cheap way to check that doesn't hammer POS on every ALB probe. Left
    // as liveness-equivalent for G2 — a real dependency check is a small,
    // low-risk follow-up once the pipeline is live end to end.
  });
  await app.register(pagesRoutes, { posBaseUrl: opts.posBaseUrl });

  return app;
}
