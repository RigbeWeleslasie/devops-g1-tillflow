/**
 * A minimal real HTTP server standing in for POS, for the web shell's own
 * tests — proves the shell's proxy/cookie plumbing against actual HTTP
 * responses, not a mocked fetch. Not a full POS reimplementation: just
 * enough of the contract (tenants, dev-tokens, sales) for the shell's
 * routes to exercise.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

export async function startFakePos(): Promise<{ app: FastifyInstance; baseUrl: string }> {
  const app = Fastify({ logger: false });
  const tenants = new Map<string, { id: string; name: string; tillNumber: string }>();
  const sales = new Map<string, { id: string; status: string; totalMinor: number; chargeId: string | null }>();

  app.post<{ Body: { name: string; tillNumber: string; ownerExternalAuthId: string; ownerDisplayName: string } }>(
    '/tenants',
    async (request, reply) => {
      const id = randomUUID();
      const tenant = { id, name: request.body.name, tillNumber: request.body.tillNumber };
      tenants.set(id, tenant);
      return reply.code(201).send({ tenant, owner: { id: randomUUID(), role: 'owner' } });
    },
  );

  app.get<{ Params: { id: string } }>('/tenants/:id', async (request, reply) => {
    const tenant = tenants.get(request.params.id);
    if (!tenant) return reply.code(404).send({ error: 'not_found' });
    return reply.send(tenant);
  });

  app.post<{ Body: { tenantId: string; externalAuthId: string } }>('/dev/tokens', async (request, reply) => {
    const payload = { sub: randomUUID(), tenantId: request.body.tenantId, role: 'owner' };
    const token = `${b64(JSON.stringify({ alg: 'none' }))}.${b64(JSON.stringify(payload))}.sig`;
    return reply.send({ token });
  });

  app.post<{ Body: { attendantId: string; items: Array<{ productId: string; quantity: number }> } }>(
    '/sales',
    async (request, reply) => {
      const id = randomUUID();
      const sale = { id, status: 'UNPAID', totalMinor: 1000, chargeId: null };
      sales.set(id, sale);
      return reply.code(201).send(sale);
    },
  );

  app.get<{ Params: { id: string } }>('/sales/:id', async (request, reply) => {
    const sale = sales.get(request.params.id);
    if (!sale) return reply.code(404).send({ error: 'not_found' });
    return reply.send(sale);
  });

  app.post<{ Params: { id: string } }>('/sales/:id/pay', async (request, reply) => {
    const sale = sales.get(request.params.id);
    if (!sale) return reply.code(404).send({ error: 'not_found' });
    sale.chargeId = randomUUID();
    return reply.code(202).send({ sale, charge: { status: 'PENDING', chargeId: sale.chargeId } });
  });

  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, baseUrl };
}

function b64(s: string): string {
  return Buffer.from(s).toString('base64url');
}
