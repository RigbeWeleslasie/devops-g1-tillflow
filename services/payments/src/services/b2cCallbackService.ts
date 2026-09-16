/**
 * B2C result callbacks — I3 applied to the payout side.
 *
 * Same discipline as the STK callback: record-and-dedupe first, then match,
 * then a guarded transition, all in one transaction. Two differences that
 * matter:
 *
 *   - The match key is OriginatorConversationID, which is OUR payout id. We
 *     chose it precisely so a result can find its row even when the request
 *     timed out and Daraja's ConversationID never reached us.
 *   - The "ledger effect" here is the payout_ledger row's terminal status,
 *     updated in the same transaction. There is no outbox event: nothing
 *     downstream subscribes to a payout, and the ledger IS the record.
 */
import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { B2C_RESULT, resultParameter, type B2CResultBody } from '@tillflow/mpesa';
import type { Db } from '../db.js';
import { withTransaction } from '../db.js';
import { callbackChecksum, MalformedCallbackError } from './callbackService.js';
import type { PayoutRow } from './payoutService.js';

export interface B2CCallbackOutcome {
  reference: string;
  resultCode: number;
  recorded: 'new' | 'duplicate';
  duplicateCount: number;
  matched: boolean;
  applied: boolean;
  transition: 'PENDING->PAID' | 'PENDING->FAILED' | null;
  payoutId: string | null;
  ledgerId: string | null;
  reason: string | null;
}

export function validateB2CCallback(body: unknown): B2CResultBody {
  const r = (body as { Result?: Record<string, unknown> })?.Result;
  if (!r || typeof r !== 'object') throw new MalformedCallbackError('Result missing');
  if (typeof r['OriginatorConversationID'] !== 'string' || r['OriginatorConversationID'] === '') {
    throw new MalformedCallbackError('OriginatorConversationID missing');
  }
  if (typeof r['ResultCode'] !== 'number' || !Number.isInteger(r['ResultCode'])) {
    throw new MalformedCallbackError('ResultCode must be an integer');
  }
  return body as B2CResultBody;
}

export interface ApplyB2COptions {
  db: Db;
  now?: () => Date;
}

export async function applyB2CCallback(body: B2CResultBody, opts: ApplyB2COptions): Promise<B2CCallbackOutcome> {
  const now = opts.now ?? (() => new Date());
  const result = body.Result;
  const reference = result.OriginatorConversationID;
  const resultCode = result.ResultCode;
  const checksum = callbackChecksum(body);
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'payout.ledger_id': reference, 'mpesa.result_code': resultCode });

  return withTransaction(opts.db, async (tx) => {
    const eventId = randomUUID();
    const rec = await tx.query<{ id: string; duplicate_count: number }>(
      `INSERT INTO callback_events (id, kind, reference, result_code, checksum, matched, applied, body, received_at)
       VALUES ($1, 'b2c', $2, $3, $4, false, false, $5, $6)
       ON CONFLICT (kind, reference, result_code, checksum)
       DO UPDATE SET duplicate_count = callback_events.duplicate_count + 1
       RETURNING id, duplicate_count`,
      [eventId, reference, resultCode, checksum, JSON.stringify(body), now().toISOString()],
    );
    const row = rec.rows[0]!;
    const base = {
      reference,
      resultCode,
      duplicateCount: row.duplicate_count,
      payoutId: null as string | null,
      ledgerId: null as string | null,
      transition: null as B2CCallbackOutcome['transition'],
    };

    if (row.duplicate_count > 0) {
      span?.setAttributes({ 'payments.callback.duplicate': true, 'payments.callback.applied': false });
      return { ...base, recorded: 'duplicate', matched: true, applied: false, reason: 'duplicate delivery' };
    }

    const payoutRes = await tx.query<PayoutRow>(
      'SELECT * FROM payouts WHERE originator_conversation_id = $1',
      [reference],
    );
    const payout = payoutRes.rows[0];
    if (!payout) {
      span?.setAttributes({ 'payments.callback.matched': false });
      return {
        ...base,
        recorded: 'new',
        matched: false,
        applied: false,
        reason: 'no payout with this OriginatorConversationID',
      };
    }
    base.payoutId = payout.id;
    base.ledgerId = payout.ledger_id;
    span?.setAttributes({ 'payments.payout_id': payout.id, 'payout.ledger_id': payout.ledger_id });

    const finish = async (applied: boolean, extra: Partial<B2CCallbackOutcome>): Promise<B2CCallbackOutcome> => {
      await tx.query('UPDATE callback_events SET matched = true, applied = $2 WHERE id = $1', [row.id, applied]);
      span?.setAttributes({ 'payments.callback.matched': true, 'payments.callback.applied': applied });
      return { ...base, recorded: 'new', matched: true, applied, reason: null, ...extra };
    };

    const ts = now().toISOString();
    const paid = resultCode === B2C_RESULT.SUCCESS;

    // If Daraja reports a different amount than we asked for, do not mark it
    // paid on that basis — record and leave PENDING for a human. Same
    // reasoning as the STK amount cross-check.
    if (paid) {
      // Matches the STK side exactly: an amount we cannot verify is not an
      // amount we accept. A missing or unparseable TransactionAmount used to
      // skip this check and mark the payout PAID — which meant the weakest
      // possible callback (one that simply omits the field) got the least
      // scrutiny. Absent is now treated as mismatched.
      const raw = resultParameter(body, 'TransactionAmount');
      const reportedKes = Number(raw);
      if (raw === undefined || !Number.isFinite(reportedKes)) {
        return finish(false, {
          reason: `success callback carried no usable TransactionAmount (got ${JSON.stringify(raw)}); not marking paid`,
        });
      }
      const reportedMinor = Math.round(reportedKes * 100);
      if (reportedMinor !== payout.amount_minor) {
        return finish(false, {
          reason: `callback amount ${reportedMinor} != payout amount ${payout.amount_minor}`,
        });
      }
    }

    const transactionId = resultParameter(body, 'TransactionReceipt') ?? result.TransactionID;
    const upd = await tx.query<{ id: string }>(
      paid
        ? `UPDATE payouts
           SET status = 'PAID', transaction_id = $2, result_code = $3, result_desc = $4, paid_at = $5, updated_at = $5
           WHERE id = $1 AND status = 'PENDING'
           RETURNING id`
        : `UPDATE payouts
           SET status = 'FAILED', transaction_id = $2, result_code = $3, result_desc = $4, failed_at = $5, updated_at = $5
           WHERE id = $1 AND status = 'PENDING'
           RETURNING id`,
      [payout.id, transactionId ? String(transactionId) : null, resultCode, result.ResultDesc, ts],
    );
    if (upd.rowCount === 0) {
      return finish(false, { reason: `payout already ${payout.status}` });
    }

    // The ledger effect, in the same transaction as the transition.
    await tx.query(
      `UPDATE payout_ledger SET status = $2, updated_at = $3 WHERE id = $1 AND status IN ('COMPUTED', 'REQUESTED')`,
      [payout.ledger_id, paid ? 'PAID' : 'FAILED', ts],
    );

    return finish(true, { transition: paid ? 'PENDING->PAID' : 'PENDING->FAILED' });
  });
}
