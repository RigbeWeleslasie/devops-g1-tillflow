/**
 * Operator endpoints, behind the service token. These exist so the runbook
 * has real commands rather than "inspect the database": every failure drill
 * in docs/runbook.md §2.1 drives these.
 *
 *   POST /admin/reconcile        run one reconcile pass now
 *   GET  /admin/pending          what is stuck, and why
 *   POST /admin/charges/:id/release   clear a hold, after a human decided
 *
 * There is deliberately NO endpoint that marks a charge PAID or FAILED by
 * hand. Money state comes from Daraja — via a callback or a query — and
 * nowhere else. An operator can unblock a decision; they cannot invent one.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { MpesaAdapter } from '@tillflow/mpesa';
import type { Db } from '../db.js';
import { chargesNeedingAttention, runReconcileOnce } from '../services/reconcileService.js';
import type { ChargeRow } from '../types.js';

export interface AdminRoutesOptions {
  db: Db;
  adapter: MpesaAdapter;
  reconcileAfterMs: number;
  reconcileMaxAttempts: number;
  now?: () => Date;
}

const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (app, opts) => {
  const now = opts.now ?? (() => new Date());

  app.post('/admin/reconcile', { preHandler: app.requireServiceToken }, async (request, reply) => {
    const summary = await runReconcileOnce({
      db: opts.db,
      adapter: opts.adapter,
      afterMs: opts.reconcileAfterMs,
      maxAttempts: opts.reconcileMaxAttempts,
      now,
      logger: request.log,
    });
    request.log.info({ ...summary }, 'manual reconcile pass');
    return reply.send(summary);
  });

  app.get('/admin/pending', { preHandler: app.requireServiceToken }, async (_request, reply) => {
    const rows = await chargesNeedingAttention(opts.db, opts.reconcileMaxAttempts);
    return reply.send({
      count: rows.length,
      charges: rows.map((c: ChargeRow) => ({
        chargeId: c.id,
        saleId: c.sale_id,
        tenantId: c.tenant_id,
        amountMinor: c.amount_minor,
        checkoutRequestId: c.checkout_request_id,
        reconcileAttempts: c.reconcile_attempts,
        holdReason: c.hold_reason,
        // Why a human is needed, in the words the runbook uses.
        situation: c.hold_reason
          ? 'on hold: a callback disagreed with our amount'
          : c.checkout_request_id
            ? 'queried repeatedly and M-Pesa still has no answer'
            : 'the STK push timed out; no CheckoutRequestID to query',
        createdAt: c.created_at,
      })),
    });
  });

  app.post<{ Params: { id: string } }>(
    '/admin/charges/:id/release',
    { preHandler: app.requireServiceToken },
    async (request, reply) => {
      const res = await opts.db.query<{ id: string }>(
        `UPDATE charges SET hold_reason = NULL, reconcile_attempts = 0, updated_at = $2
         WHERE id = $1 AND status = 'PENDING' AND hold_reason IS NOT NULL
         RETURNING id`,
        [request.params.id, now().toISOString()],
      );
      if (res.rowCount === 0) {
        return reply.code(404).send({ error: 'not_found', message: 'no PENDING charge on hold with that id' });
      }
      request.log.warn({ chargeId: request.params.id }, 'hold released by operator; reconciliation may now resolve it');
      return reply.send({ chargeId: request.params.id, released: true });
    },
  );

  // The audit trail for one charge: every callback we received about it and
  // every ledger effect it produced. This is what docs/runbook.md §2.2 asks an
  // operator to check ("one legal transition, one ledger effect") and what the
  // G4 drill asserts — over HTTP, so neither needs a route to RDS.
  //
  // I3 reads off this directly: `callbackEvents` should be ONE row per distinct
  // callback with `duplicateCount` counting redeliveries, `applied` true
  // exactly once; `outboxEvents` should be exactly one `sale.paid` for a PAID
  // charge and none otherwise.
  app.get<{ Params: { id: string } }>(
    '/admin/charges/:id/audit',
    { preHandler: app.requireServiceToken },
    async (request, reply) => {
      const charge = await opts.db.query<ChargeRow>('SELECT * FROM charges WHERE id = $1', [request.params.id]);
      const c = charge.rows[0];
      if (!c) return reply.code(404).send({ error: 'not_found' });

      const callbacks = await opts.db.query<{
        id: string;
        kind: string;
        result_code: number;
        matched: boolean;
        applied: boolean;
        duplicate_count: number;
        received_at: string | Date;
      }>(
        `SELECT id, kind, result_code, matched, applied, duplicate_count, received_at
         FROM callback_events WHERE reference = $1 ORDER BY received_at`,
        [c.checkout_request_id],
      );
      const outbox = await opts.db.query<{
        id: string;
        event_type: string;
        created_at: string | Date;
        published_at: string | Date | null;
      }>(
        `SELECT id, event_type, created_at, published_at
         FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at`,
        [c.id],
      );

      return reply.send({
        chargeId: c.id,
        status: c.status,
        checkoutRequestId: c.checkout_request_id,
        holdReason: c.hold_reason,
        stkAttempts: c.stk_attempts,
        reconcileAttempts: c.reconcile_attempts,
        callbackEvents: callbacks.rows.map((e) => ({
          id: e.id,
          kind: e.kind,
          resultCode: e.result_code,
          matched: e.matched,
          applied: e.applied,
          duplicateCount: e.duplicate_count,
          receivedAt: e.received_at,
        })),
        outboxEvents: outbox.rows.map((e) => ({
          id: e.id,
          eventType: e.event_type,
          createdAt: e.created_at,
          publishedAt: e.published_at,
        })),
      });
    },
  );
};

export default adminRoutes;
