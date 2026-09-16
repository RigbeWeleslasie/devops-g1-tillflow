/**
 * POST /payouts — the contract the commission worker depends on. Idempotent
 * on ledgerId; 201 when created, 200 when the payout already existed.
 *
 * This is the ONLY way B2C is ever requested. The commission worker holds no
 * Daraja credentials and its task role cannot read the daraja secret
 * (infra/data.tf), so the architecture's hard rule — "a direct Daraja call
 * from commission fails G2" — is enforced by IAM, not just by convention.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { MpesaAdapter } from '@tillflow/mpesa';
import type { Db } from '../db.js';
import { ValidationError } from '../services/chargeService.js';
import {
  createPayout,
  getPayout,
  getPayoutByLedgerId,
  LedgerNotFoundError,
  toPayoutResponse,
  validateCreatePayout,
} from '../services/payoutService.js';

export interface PayoutsRoutesOptions {
  db: Db;
  adapter: MpesaAdapter;
  callbackBaseUrl: string;
  now?: () => Date;
}

const payoutsRoutes: FastifyPluginAsync<PayoutsRoutesOptions> = async (app, opts) => {
  app.post('/payouts', { preHandler: app.requireServiceToken }, async (request, reply) => {
    let input;
    try {
      input = validateCreatePayout(request.body);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }

    const hintHeader = request.headers['x-fake-scenario'];
    const hint = Array.isArray(hintHeader) ? hintHeader[0] : hintHeader;
    if (hint) input = { ...input, scenarioHint: hint };

    try {
      const { payout, created } = await createPayout(input, {
        db: opts.db,
        adapter: opts.adapter,
        callbackBaseUrl: opts.callbackBaseUrl,
        ...(opts.now ? { now: opts.now } : {}),
      });

      request.log.info(
        {
          'payments.payout_id': payout.id,
          'payout.ledger_id': payout.ledger_id,
          tenantId: payout.tenant_id,
          amountMinor: payout.amount_minor,
          status: payout.status,
          created,
        },
        created ? 'payout requested' : 'payout already existed (I4: no second disbursement)',
      );

      return reply.code(created ? 201 : 200).send(toPayoutResponse(payout, created));
    } catch (err) {
      if (err instanceof LedgerNotFoundError) {
        return reply.code(404).send({ error: 'ledger_not_found', message: err.message });
      }
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>(
    '/payouts/:id',
    { preHandler: app.requireServiceToken },
    async (request, reply) => {
      const payout = await getPayout(opts.db, request.params.id);
      if (!payout) return reply.code(404).send({ error: 'not_found' });
      return reply.send(toPayoutResponse(payout, false));
    },
  );

  app.get<{ Params: { ledgerId: string } }>(
    '/payouts/by-ledger/:ledgerId',
    { preHandler: app.requireServiceToken },
    async (request, reply) => {
      const payout = await getPayoutByLedgerId(opts.db, request.params.ledgerId);
      if (!payout) return reply.code(404).send({ error: 'not_found' });
      return reply.send(toPayoutResponse(payout, false));
    },
  );
};

export default payoutsRoutes;
