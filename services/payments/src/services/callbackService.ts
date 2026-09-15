/**
 * Inbound Daraja callbacks: I3 — one legal transition and one ledger
 * effect per callback, at any order or repetition count.
 *
 * Everything for one callback happens in ONE transaction, in this order:
 *
 *   1. Record the callback in callback_events, keyed on
 *      (kind, reference, result_code, checksum). An identical redelivery
 *      hits the unique key and bumps duplicate_count instead. This happens
 *      FIRST so a duplicate never reaches the transition logic at all —
 *      "second span, zero state writes".
 *   2. Match the reference to a charge WE issued. Unknown -> stored,
 *      matched=false, nothing applied. (threat-model.md A2)
 *   3. Cross-check the callback's amount against ours. Mismatch -> the
 *      charge is put on hold (hold_reason), nothing applied. (A1)
 *   4. Guarded transition: UPDATE ... WHERE status = 'PENDING'. Zero rows
 *      means someone (an earlier callback, the reconciler) already resolved
 *      it. First wins; the rest are recorded, applied=false.
 *   5. If the transition was to PAID, write the sale.paid outbox row — the
 *      one ledger effect. UNIQUE(event_type, aggregate_id) is the DB's own
 *      guarantee there is never a second one.
 *
 * Commit, or roll all of it back. There is no state where a charge is PAID
 * and the event was never recorded, or where the event exists twice.
 */
import { createHash, randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { metadataItem, STK_RESULT, type StkCallbackBody } from '@tillflow/mpesa';
import type { SalePaidEvent } from '@tillflow/shared/events';
import type { Db, Tx } from '../db.js';
import { withTransaction } from '../db.js';
import type { ChargeRow } from '../types.js';

export interface CallbackOutcome {
  kind: 'stk' | 'b2c';
  reference: string;
  resultCode: number;
  /** 'new' = first time we've seen these bytes; 'duplicate' = identical redelivery. */
  recorded: 'new' | 'duplicate';
  duplicateCount: number;
  matched: boolean;
  applied: boolean;
  transition: 'PENDING->PAID' | 'PENDING->FAILED' | null;
  chargeId: string | null;
  /** Why nothing was applied, when nothing was. */
  reason: string | null;
}

export class MalformedCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedCallbackError';
  }
}

export function validateStkCallback(body: unknown): StkCallbackBody {
  const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } })?.Body?.stkCallback;
  if (!cb || typeof cb !== 'object') throw new MalformedCallbackError('Body.stkCallback missing');
  if (typeof cb['CheckoutRequestID'] !== 'string' || cb['CheckoutRequestID'] === '') {
    throw new MalformedCallbackError('CheckoutRequestID missing');
  }
  if (typeof cb['ResultCode'] !== 'number' || !Number.isInteger(cb['ResultCode'])) {
    throw new MalformedCallbackError('ResultCode must be an integer');
  }
  return body as StkCallbackBody;
}

/** Stable hash of the callback body, independent of key order. */
export function callbackChecksum(body: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, normalize(val)]),
      );
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(normalize(body))).digest('hex');
}

/** Daraja's TransactionDate is yyyyMMddHHmmss in EAT (UTC+3). */
export function parseDarajaDate(v: string | number | undefined): Date | null {
  if (v === undefined) return null;
  const s = String(v);
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 3, Number(mi), Number(se)));
}

export interface ApplyOptions {
  db: Db;
  now?: () => Date;
}

export async function applyStkCallback(body: StkCallbackBody, opts: ApplyOptions): Promise<CallbackOutcome> {
  const now = opts.now ?? (() => new Date());
  const cb = body.Body.stkCallback;
  const reference = cb.CheckoutRequestID;
  const resultCode = cb.ResultCode;
  const checksum = callbackChecksum(body);
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'mpesa.checkout_request_id': reference, 'mpesa.result_code': resultCode });

  return withTransaction(opts.db, async (tx) => {
    // 1. Record. Dedupe happens here, before anything else.
    const eventId = randomUUID();
    const rec = await tx.query<{ id: string; duplicate_count: number }>(
      `INSERT INTO callback_events (id, kind, reference, result_code, checksum, matched, applied, body, received_at)
       VALUES ($1, 'stk', $2, $3, $4, false, false, $5, $6)
       ON CONFLICT (kind, reference, result_code, checksum)
       DO UPDATE SET duplicate_count = callback_events.duplicate_count + 1
       RETURNING id, duplicate_count`,
      [eventId, reference, resultCode, checksum, JSON.stringify(body), now().toISOString()],
    );
    const row = rec.rows[0]!;
    const duplicateCount = row.duplicate_count;

    const base = {
      kind: 'stk' as const,
      reference,
      resultCode,
      duplicateCount,
      chargeId: null as string | null,
      transition: null as CallbackOutcome['transition'],
    };

    if (duplicateCount > 0) {
      span?.setAttributes({ 'payments.callback.duplicate': true, 'payments.callback.applied': false });
      return { ...base, recorded: 'duplicate', matched: true, applied: false, reason: 'duplicate delivery' };
    }

    // 2. Match to a charge we issued.
    const chargeRes = await tx.query<ChargeRow>('SELECT * FROM charges WHERE checkout_request_id = $1', [reference]);
    const charge = chargeRes.rows[0];
    if (!charge) {
      span?.setAttributes({ 'payments.callback.matched': false, 'payments.callback.applied': false });
      return { ...base, recorded: 'new', matched: false, applied: false, reason: 'no charge with this CheckoutRequestID' };
    }
    base.chargeId = charge.id;
    span?.setAttributes({ 'payments.charge_id': charge.id, 'payments.sale_id': charge.sale_id });

    const finish = async (applied: boolean, extra: Partial<CallbackOutcome>): Promise<CallbackOutcome> => {
      await tx.query('UPDATE callback_events SET matched = true, applied = $2 WHERE id = $1', [row.id, applied]);
      span?.setAttributes({ 'payments.callback.matched': true, 'payments.callback.applied': applied });
      return { ...base, recorded: 'new', matched: true, applied, reason: null, ...extra };
    };

    const ts = now().toISOString();

    if (resultCode === STK_RESULT.SUCCESS) {
      // 3. Amount cross-check. Daraja reports whole KES.
      const reportedKes = Number(metadataItem(body, 'Amount'));
      const reportedMinor = Number.isFinite(reportedKes) ? Math.round(reportedKes * 100) : NaN;
      if (reportedMinor !== charge.amount_minor) {
        const reason = `callback amount ${reportedMinor} != charge amount ${charge.amount_minor}`;
        await tx.query(
          `UPDATE charges SET hold_reason = $2, updated_at = $3 WHERE id = $1 AND status = 'PENDING' AND hold_reason IS NULL`,
          [charge.id, reason, ts],
        );
        span?.setAttributes({ 'payments.charge.hold': true });
        return finish(false, { reason });
      }
      if (charge.hold_reason) {
        return finish(false, { reason: `charge on hold: ${charge.hold_reason}` });
      }

      // 4. Guarded transition to PAID.
      const receipt = metadataItem(body, 'MpesaReceiptNumber');
      const paidAt = parseDarajaDate(metadataItem(body, 'TransactionDate')) ?? now();
      const upd = await tx.query<{ id: string }>(
        `UPDATE charges
         SET status = 'PAID', mpesa_receipt = $2, result_code = $3, result_desc = $4, resolved_by = 'callback',
             paid_at = $5, updated_at = $6
         WHERE id = $1 AND status = 'PENDING'
         RETURNING id`,
        [charge.id, receipt === undefined ? null : String(receipt), resultCode, cb.ResultDesc, paidAt.toISOString(), ts],
      );
      if (upd.rowCount === 0) {
        return finish(false, { reason: `charge already ${charge.status}` });
      }

      // 5. The one ledger effect.
      await writeSalePaidOutbox(tx, charge, paidAt, now());
      return finish(true, { transition: 'PENDING->PAID' });
    }

    // Any non-zero ResultCode is a definite decline from Daraja.
    const upd = await tx.query<{ id: string }>(
      `UPDATE charges
       SET status = 'FAILED', result_code = $2, result_desc = $3, resolved_by = 'callback', failed_at = $4, updated_at = $4
       WHERE id = $1 AND status = 'PENDING'
       RETURNING id`,
      [charge.id, resultCode, cb.ResultDesc, ts],
    );
    if (upd.rowCount === 0) {
      return finish(false, { reason: `charge already ${charge.status}` });
    }
    return finish(true, { transition: 'PENDING->FAILED' });
  });
}

/**
 * The sale.paid event, as a row. Shared by the callback path and the
 * reconciler's query path so both produce byte-identical events. Must be
 * called inside the transaction that made the charge PAID.
 */
export async function writeSalePaidOutbox(tx: Tx, charge: ChargeRow, paidAt: Date, now: Date): Promise<string> {
  const outboxId = randomUUID();
  const event: SalePaidEvent = {
    eventType: 'sale.paid',
    eventId: outboxId,
    occurredAt: now.toISOString(),
    data: {
      saleId: charge.sale_id,
      tenantId: charge.tenant_id,
      chargeId: charge.id,
      amountMinor: charge.amount_minor,
      paidAt: paidAt.toISOString(),
    },
  };
  await tx.query(
    `INSERT INTO outbox_events (id, event_type, aggregate_id, payload, created_at) VALUES ($1, 'sale.paid', $2, $3, $4)`,
    [outboxId, charge.id, JSON.stringify(event), now.toISOString()],
  );
  return outboxId;
}
