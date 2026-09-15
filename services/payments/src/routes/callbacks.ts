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
import { applyB2CCallback, validateB2CCallback } from '../services/b2cCallbackService.js';

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

  app.post('/callbacks/b2c', async (request, reply) => {
    let body;
    try {
      body = validateB2CCallback(request.body);
    } catch (err) {
      if (err instanceof MalformedCallbackError) {
        request.log.warn({ err: err.message }, 'b2c callback: malformed');
        return reply.code(400).send({ ResultCode: 1, ResultDesc: err.message });
      }
      throw err;
    }

    const outcome = await applyB2CCallback(body, {
      db: opts.db,
      ...(opts.now ? { now: opts.now } : {}),
    });

    request.log.info(
      {
        'payout.ledger_id': outcome.ledgerId,
        'payments.payout_id': outcome.payoutId,
        'mpesa.result_code': outcome.resultCode,
        recorded: outcome.recorded,
        duplicateCount: outcome.duplicateCount,
        matched: outcome.matched,
        applied: outcome.applied,
        transition: outcome.transition,
        reason: outcome.reason,
      },
      outcome.applied
        ? `b2c callback applied: ${outcome.transition}`
        : `b2c callback recorded, not applied: ${outcome.reason}`,
    );

    return reply.code(200).send(DARAJA_ACK);
  });

  // Daraja posts here when a B2C request exceeds its own queue timeout. It
  // is NOT a failure result: the request may still complete. Record it and
  // leave the payout PENDING for the result callback or an operator (I5).
  app.post('/callbacks/b2c-timeout', async (request, reply) => {
    request.log.warn({ body: request.body }, 'b2c queue timeout notice; payout stays PENDING');
    return reply.code(200).send(DARAJA_ACK);
  });
};

export default callbacksRoutes;
