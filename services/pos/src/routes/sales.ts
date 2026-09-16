/**
 * POST /sales, POST /sales/{id}/pay, GET /sales/{id}.
 *
 * Every route requires auth; tenant_id always comes from request.principal
 * (the verified token), never from the URL or body. GET is the route the
 * IDOR requirement names explicitly, but the same tenant-scoped-query
 * pattern (services/saleService.ts's getSale) is what /pay relies on too.
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import type { PaymentsClient } from '../services/paymentsClient.js';
import {
  createSale,
  getSale,
  paySale,
  IdempotencyConflictError,
  InvalidStateError,
  NotFoundError,
  ValidationError,
} from '../services/saleService.js';

export interface SalesRoutesOptions {
  db: Db;
  paymentsClient: PaymentsClient;
}

export default async function salesRoutes(app: FastifyInstance, opts: SalesRoutesOptions) {
  const { db, paymentsClient } = opts;

  app.post<{
    Body: { attendantId: string; items: Array<{ productId: string; quantity: number }> };
    Headers: { 'idempotency-key'?: string };
  }>('/sales', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const idempotencyKey = request.headers['idempotency-key'];
    if (!idempotencyKey) {
      return reply.code(400).send({ error: 'missing_idempotency_key', message: 'Idempotency-Key header is required' });
    }
    const tenantId = request.principal!.tenantId;
    const { attendantId, items } = request.body;
    if (!attendantId || !Array.isArray(items) || items.length === 0) {
      return reply.code(422).send({ error: 'invalid_request' });
    }

    try {
      const result = await createSale(db, tenantId, attendantId, items, idempotencyKey);
      return reply.code(result.status).send(result.body);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return reply.code(409).send({ error: 'idempotency_key_conflict', message: err.message });
      }
      if (err instanceof NotFoundError) {
        return reply.code(404).send({ error: 'not_found', message: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>(
    '/sales/:id',
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const tenantId = request.principal!.tenantId;
      const sale = await getSale(db, tenantId, request.params.id);
      // No distinction between "doesn't exist" and "belongs to another
      // tenant" — both are exactly this 404, nothing else.
      if (!sale) return reply.code(404).send({ error: 'not_found' });
      return reply.send(sale);
    },
  );

  app.post<{ Params: { id: string }; Body: { customerMsisdn?: string } }>(
    '/sales/:id/pay',
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const tenantId = request.principal!.tenantId;
      const customerMsisdn = request.body?.customerMsisdn;
      if (!customerMsisdn || typeof customerMsisdn !== 'string') {
        return reply
          .code(400)
          .send({ error: 'missing_customer_msisdn', message: 'customerMsisdn is required' });
      }
      try {
        const result = await paySale(db, paymentsClient, tenantId, request.params.id, customerMsisdn);
        return reply.code(202).send(result);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply.code(404).send({ error: 'not_found', message: err.message });
        }
        if (err instanceof InvalidStateError) {
          return reply.code(409).send({ error: 'invalid_state', message: err.message });
        }
        if (err instanceof ValidationError) {
          return reply.code(400).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
}
