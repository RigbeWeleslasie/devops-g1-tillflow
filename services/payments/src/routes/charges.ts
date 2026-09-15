/**
 * POST /charges — the one contract POS depends on (services/pos/src/services/
 * paymentsClient.ts). Idempotent on saleId; 201 when created, 200 when the
 * charge already existed. Either way the body is the charge's current state.
 *
 * GET /charges/:id and GET /charges/by-sale/:saleId — read-back for POS,
 * the demo, and the drills.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { MpesaAdapter } from '@tillflow/mpesa';
import type { Db } from '../db.js';
import {
  createCharge,
  getCharge,
  getChargeBySaleId,
  validateCreateCharge,
  ValidationError,
} from '../services/chargeService.js';
import type { Charge, ChargeResponse } from '../types.js';

export interface ChargesRoutesOptions {
  db: Db;
  adapter: MpesaAdapter;
  callbackBaseUrl: string;
}

export function toChargeResponse(charge: Charge, created: boolean): ChargeResponse {
  return {
    chargeId: charge.id,
    saleId: charge.saleId,
    status: charge.status,
    amountMinor: charge.amountMinor,
    checkoutRequestId: charge.checkoutRequestId,
    created,
  };
}

const chargesRoutes: FastifyPluginAsync<ChargesRoutesOptions> = async (app, opts) => {
  app.post('/charges', { preHandler: app.requireServiceToken }, async (request, reply) => {
    let input;
    try {
      input = validateCreateCharge(request.body);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }

    // A drill can force a scenario with a header; the fake / stub honour it,
    // the real sandbox ignores it.
    const hintHeader = request.headers['x-fake-scenario'];
    const hint = Array.isArray(hintHeader) ? hintHeader[0] : hintHeader;
    if (hint) input = { ...input, scenarioHint: hint };

    const { charge, created } = await createCharge(input, {
      db: opts.db,
      adapter: opts.adapter,
      callbackBaseUrl: opts.callbackBaseUrl,
    });

    request.log.info(
      {
        chargeId: charge.id,
        saleId: charge.saleId,
        tenantId: charge.tenantId,
        status: charge.status,
        created,
        checkoutRequestId: charge.checkoutRequestId,
        'mpesa.checkout_request_id': charge.checkoutRequestId,
      },
      created ? 'charge created' : 'charge already existed (I2: no second push)',
    );

    return reply.code(created ? 201 : 200).send(toChargeResponse(charge, created));
  });

  app.get<{ Params: { id: string } }>(
    '/charges/:id',
    { preHandler: app.requireServiceToken },
    async (request, reply) => {
      const charge = await getCharge(opts.db, request.params.id);
      if (!charge) return reply.code(404).send({ error: 'not_found' });
      return reply.send(toChargeResponse(charge, false));
    },
  );

  app.get<{ Params: { saleId: string } }>(
    '/charges/by-sale/:saleId',
    { preHandler: app.requireServiceToken },
    async (request, reply) => {
      const charge = await getChargeBySaleId(opts.db, request.params.saleId);
      if (!charge) return reply.code(404).send({ error: 'not_found' });
      return reply.send(toChargeResponse(charge, false));
    },
  );
};

export default chargesRoutes;
