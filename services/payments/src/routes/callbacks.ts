/**
 * Daraja callback endpoints. Unauthenticated by nature — Safaricom cannot
 * send our service token — and guarded instead by reference matching and
 * amount cross-check inside the callback service.
 *
 * Response discipline: 200 with Daraja's expected ack for anything we could
 * record, including duplicates, unmatched references and holds — Daraja
 * only needs to know it was received. 400 for a body we cannot parse. 500
 * (via the default error handler) if the transaction failed, so Daraja
 * retries. The outcome goes to the log and the trace, not the body: the
 * caller is the internet.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db.js';
import { applyStkCallback, MalformedCallbackError, validateStkCallback } from '../services/callbackService.js';

export interface CallbacksRoutesOptions {
  db: Db;
  now?: () => Date;
}

const DARAJA_ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

const callbacksRoutes: FastifyPluginAsync<CallbacksRoutesOptions> = async (app, opts) => {
  app.post('/callbacks/stk', async (request, reply) => {
    let body;
    try {
      body = validateStkCallback(request.body);
    } catch (err) {
      if (err instanceof MalformedCallbackError) {
        request.log.warn({ err: err.message }, 'stk callback: malformed');
        return reply.code(400).send({ ResultCode: 1, ResultDesc: err.message });
      }
      throw err;
    }

    const outcome = await applyStkCallback(body, {
      db: opts.db,
      ...(opts.now ? { now: opts.now } : {}),
    });

    request.log.info(
      {
        'mpesa.checkout_request_id': outcome.reference,
        'mpesa.result_code': outcome.resultCode,
        chargeId: outcome.chargeId,
        recorded: outcome.recorded,
        duplicateCount: outcome.duplicateCount,
        matched: outcome.matched,
        applied: outcome.applied,
        transition: outcome.transition,
        reason: outcome.reason,
      },
      outcome.applied
        ? `stk callback applied: ${outcome.transition}`
        : `stk callback recorded, not applied: ${outcome.reason}`,
    );

    return reply.code(200).send(DARAJA_ACK);
  });
};

export default callbacksRoutes;
