/**
 * Service-to-service auth for the internal command routes (/charges,
 * /payouts, /admin/*). These are reachable from the internet through API
 * Gateway — it proxies every path to the ALB — so a caller must present the
 * shared X-Service-Token (Secrets Manager `devops-g1/service-token`, injected
 * as SERVICE_TOKEN). threat-model.md §3.2 calls this the G2 "authz header".
 *
 * Daraja callbacks are deliberately NOT behind this: Safaricom cannot send our
 * header. They are protected differently — a callback only applies if its
 * CheckoutRequestID / ConversationID matches a charge/payout WE issued, and
 * its amount matches ours (chargeService / payoutService).
 *
 * Constant-time compare so the token can't be recovered byte by byte from
 * response timing.
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

export default fp<ServiceAuthOptions>(async function serviceAuthPlugin(app: FastifyInstance, opts) {
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
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return reply.code(401).send({ error: 'unauthorized', reason: 'invalid X-Service-Token' });
    }
  });
});
