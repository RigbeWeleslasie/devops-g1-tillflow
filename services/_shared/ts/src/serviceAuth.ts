/**
 * Service-to-service auth for internal command routes.
 *
 * API Gateway proxies every path to the ALB, so a route like POST /charges
 * or GET /internal/daily-close is reachable from the internet even though
 * only another service should ever call it. A shared bearer token
 * (Secrets Manager `devops-g1/service-token`, injected as SERVICE_TOKEN)
 * is the G2 "authz header" threat-model.md §3.2 calls for.
 *
 * Lives here rather than in one service because POS and Payments both need
 * it and a second copy would be a second thing to get wrong. Path is
 * co-owned (CODEOWNERS: /services/_shared/ -> @meronkahsay @nebyathhailu).
 *
 * Provider callbacks are deliberately NOT behind this — Safaricom cannot
 * send our header. Those are guarded by reference matching and amount
 * cross-checks instead.
 */
import fp from 'fastify-plugin';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface ServiceAuthOptions {
  serviceToken: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireServiceToken: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const serviceAuthPlugin = fp<ServiceAuthOptions>(async function serviceAuthPlugin(
  app: FastifyInstance,
  opts,
) {
  if (!opts.serviceToken || opts.serviceToken.length < 16) {
    throw new Error('SERVICE_TOKEN must be set and at least 16 characters');
  }
  const expected = Buffer.from(opts.serviceToken, 'utf8');

  app.decorate('requireServiceToken', async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers['x-service-token'];
    const presented = Array.isArray(header) ? header[0] : header;
    if (!presented) {
      return reply.code(401).send({ error: 'unauthorized', reason: 'missing X-Service-Token' });
    }
    const got = Buffer.from(presented, 'utf8');
    // Length-check first: timingSafeEqual throws on a length mismatch, and
    // comparing lengths leaks nothing an attacker cannot already measure.
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return reply.code(401).send({ error: 'unauthorized', reason: 'invalid X-Service-Token' });
    }
  });
});

export default serviceAuthPlugin;
