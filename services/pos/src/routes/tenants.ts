/**
 * Tenant setup routes. POST /tenants is the one unauthenticated route in
 * this service (bootstrapping tenant #1 — see tenantService.ts). Everything
 * else requires an owner token AND a path tenantId matching the token's
 * tenantId; a mismatch is a 404, never a 403 — ADR 0007's IDOR boundary,
 * applied to writes the same way it applies to reads.
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import {
  bootstrapTenant,
  createAttendant,
  createProduct,
  getTenant,
  setCommissionRate,
} from '../services/tenantService.js';

export interface TenantRoutesOptions {
  db: Db;
}

function tenantScoped(app: FastifyInstance) {
  return async (request: { principal?: { tenantId: string }; params: { tenantId: string } }, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!request.principal || request.principal.tenantId !== request.params.tenantId) {
      // Same response whether the tenant genuinely doesn't exist or the
      // caller just isn't a member of it — no existence leak either way.
      reply.code(404).send({ error: 'not_found' });
    }
  };
}

export default async function tenantRoutes(app: FastifyInstance, opts: TenantRoutesOptions) {
  const { db } = opts;
  const scoped = tenantScoped(app);

  app.post<{
    Body: { name: string; tillNumber: string; ownerExternalAuthId: string; ownerDisplayName: string };
  }>('/tenants', async (request, reply) => {
    const { name, tillNumber, ownerExternalAuthId, ownerDisplayName } = request.body;
    if (!name || !tillNumber || !ownerExternalAuthId || !ownerDisplayName) {
      return reply.code(422).send({ error: 'invalid_request' });
    }
    const result = await bootstrapTenant(db, { name, tillNumber, ownerExternalAuthId, ownerDisplayName });
    return reply.code(201).send(result);
  });

  app.get<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId',
    { preHandler: [app.requireAuth, scoped] },
    async (request, reply) => {
      const tenant = await getTenant(db, request.params.tenantId);
      if (!tenant) return reply.code(404).send({ error: 'not_found' });
      return reply.send(tenant);
    },
  );

  app.post<{
    Params: { tenantId: string };
    Body: { externalAuthId: string; displayName: string; msisdn: string };
  }>(
    '/tenants/:tenantId/attendants',
    { preHandler: [app.requireAuth, scoped, app.requireRole('owner')] },
    async (request, reply) => {
      const attendant = await createAttendant(db, request.params.tenantId, request.body);
      return reply.code(201).send(attendant);
    },
  );

  app.post<{
    Params: { tenantId: string };
    Body: { attendantId?: string; rateBps: number };
  }>(
    '/tenants/:tenantId/rates',
    { preHandler: [app.requireAuth, scoped, app.requireRole('owner')] },
    async (request, reply) => {
      const rate = await setCommissionRate(db, request.params.tenantId, request.body);
      return reply.code(201).send(rate);
    },
  );

  app.post<{
    Params: { tenantId: string };
    Body: { name: string; unitPriceMinor: number };
  }>(
    '/tenants/:tenantId/products',
    { preHandler: [app.requireAuth, scoped, app.requireRole('owner')] },
    async (request, reply) => {
      const product = await createProduct(db, request.params.tenantId, request.body);
      return reply.code(201).send(product);
    },
  );
}
