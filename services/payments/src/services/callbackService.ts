/**
 * Inbound Daraja callbacks: I3 — one legal transition and one ledger
 * effect per callback, at any order or repetition count.
 *
 * Everything for one callback happens in ONE transaction, in this order:
 *
 *   1. Record it in callback_events, keyed on
 *      (kind, reference, result_code, checksum). An identical redelivery
 *      hits the unique key and bumps duplicate_count instead. This is FIRST
 *      so a duplicate never reaches the transition logic at all — "second
 *      span, zero state writes".
 *   2. Match the reference to a charge we issued. If the reference is
 *      unknown, try to ADOPT it for a charge whose push timed out (see
 *      findAdoptableCharge). Still no match -> stored, matched=false,
 *      nothing applied (threat-model.md A2).
 *   3. Cross-check the callback's amount against ours. Mismatch -> the
 *      charge goes on hold, nothing applied (A1).
 *   4. Guarded transition via applyChargeResolution — the same code path
 *      the reconciler uses, so callback and query can never disagree.
 *   5. On PAID, the sale.paid outbox row is written inside that same
 *      transaction.
 *
 * Commit, or roll all of it back.
 */
import { createHash, randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { metadataItem, STK_RESULT, type StkCallbackBody } from '@tillflow/mpesa';
import type { Db, Tx } from '../db.js';
import { withTransaction } from '../db.js';
import type { ChargeRow } from '../types.js';
import { applyChargeResolution } from './resolution.js';

export interface CallbackOutcome {
  kind: 'stk' | 'b2c';
  reference: string;
  resultCode: number;
  /** 'new' = first time we've seen these bytes; 'duplicate' = identical redelivery. */
  recorded: 'new' | 'duplicate';
  duplicateCount: number;
  matched: boolean;
  /** True when this callback was matched by re-association after a timed-out push. */
  adopted: boolean;
  applied: boolean;
  transition: 'PENDING->PAID' | 'PENDING->FAILED' | null;
  chargeId: string | null;
  /**
   * The charge was put on hold for a human (threat-model A1) rather than
   * resolved. Carried as a field and not inferred from `reason` because for
   * the SLI it is the difference between an error and a correct no-op: a hold
   * is a real payment that never reached its terminal state, while an
   * already-terminal charge is dedupe working. Both look identical otherwise
   * — matched, not applied, no transition — and a reworded log message must
   * not be able to change which one a metric reports.
   */
  heldForReview: boolean;
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
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(v));
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 3, Number(mi), Number(se)));
}

/** How long after creation a timed-out charge may still adopt a late callback. */
export const ADOPTION_WINDOW_MS = 30 * 60_000;

/**
 * Re-association for the uncertain-payment case.
 *
 * When an STK push times out we never receive the CheckoutRequestID, so a
 * callback that later arrives for it matches nothing — and the customer may
 * well have paid. Daraja offers no way to query by our own reference, so the
 * only handle we have is the request itself: same MSISDN, same amount, still
 * PENDING with no id of its own, created recently.
 *
 * Adoption is deliberately conservative. It requires EXACTLY ONE candidate:
 * if two charges for the same phone and amount are in flight we cannot tell
 * which one the money belongs to, so we adopt neither and leave both for a
 * human. Guessing here would credit the wrong sale.
 */
export async function findAdoptableCharge(
  tx: Tx,
  opts: { amountMinor: number; msisdn: string; now: Date },
): Promise<ChargeRow | 'none' | 'ambiguous'> {
  const since = new Date(opts.now.getTime() - ADOPTION_WINDOW_MS).toISOString();
  const res = await tx.query<ChargeRow>(
    `SELECT * FROM charges
     WHERE status = 'PENDING'
       AND checkout_request_id IS NULL
       AND hold_reason IS NULL
       AND amount_minor = $1
       AND customer_msisdn = $2
       AND created_at >= $3`,
    [opts.amountMinor, opts.msisdn, since],
  );
  if (res.rows.length === 0) return 'none';
  if (res.rows.length > 1) return 'ambiguous';
  return res.rows[0]!;
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
      adopted: false,
      heldForReview: false,
      chargeId: null as string | null,
      transition: null as CallbackOutcome['transition'],
    };

    if (duplicateCount > 0) {
      span?.setAttributes({ 'payments.callback.duplicate': true, 'payments.callback.applied': false });
      return { ...base, recorded: 'duplicate', matched: true, applied: false, reason: 'duplicate delivery' };
    }

    const nowDate = now();
    const reportedKes = Number(metadataItem(body, 'Amount'));
    const reportedMinor = Number.isFinite(reportedKes) ? Math.round(reportedKes * 100) : NaN;

    // 2. Match by CheckoutRequestID; failing that, try adoption.
    let charge: ChargeRow | undefined;
    let adopted = false;
    const byRef = await tx.query<ChargeRow>('SELECT * FROM charges WHERE checkout_request_id = $1', [reference]);
    charge = byRef.rows[0];

    if (!charge && resultCode === STK_RESULT.SUCCESS && Number.isFinite(reportedMinor)) {
      const phone = String(metadataItem(body, 'PhoneNumber') ?? '');
      const candidate = await findAdoptableCharge(tx, {
        amountMinor: reportedMinor,
        msisdn: phone,
        now: nowDate,
      });
      if (candidate === 'ambiguous') {
        span?.setAttributes({ 'payments.callback.matched': false, 'payments.callback.adoption': 'ambiguous' });
        return {
          ...base,
          recorded: 'new',
          matched: false,
          applied: false,
          reason: 'more than one timed-out charge matches this phone and amount; a human must decide',
        };
      }
      if (candidate !== 'none') {
        // Claim the reference for this charge, guarded so two concurrent
        // callbacks cannot both adopt it.
        const claim = await tx.query<{ id: string }>(
          `UPDATE charges SET checkout_request_id = $2, updated_at = $3
           WHERE id = $1 AND checkout_request_id IS NULL AND status = 'PENDING'
           RETURNING id`,
          [candidate.id, reference, nowDate.toISOString()],
        );
        if (claim.rowCount === 1) {
          charge = { ...candidate, checkout_request_id: reference };
          adopted = true;
        }
      }
    }

    if (!charge) {
      span?.setAttributes({ 'payments.callback.matched': false, 'payments.callback.applied': false });
      return { ...base, recorded: 'new', matched: false, applied: false, reason: 'no charge with this CheckoutRequestID' };
    }

    base.chargeId = charge.id;
    base.adopted = adopted;
    span?.setAttributes({
      'payments.charge_id': charge.id,
      'payments.sale_id': charge.sale_id,
      'payments.callback.adopted': adopted,
    });

    const finish = async (applied: boolean, extra: Partial<CallbackOutcome>): Promise<CallbackOutcome> => {
      await tx.query('UPDATE callback_events SET matched = true, applied = $2 WHERE id = $1', [row.id, applied]);
      span?.setAttributes({ 'payments.callback.matched': true, 'payments.callback.applied': applied });
      return { ...base, recorded: 'new', matched: true, applied, reason: null, ...extra };
    };

    if (resultCode === STK_RESULT.SUCCESS) {
      // 3. Amount cross-check. Daraja reports whole KES.
      if (reportedMinor !== charge.amount_minor) {
        const reason = `callback amount ${reportedMinor} != charge amount ${charge.amount_minor}`;
        await tx.query(
          `UPDATE charges SET hold_reason = $2, updated_at = $3
           WHERE id = $1 AND status = 'PENDING' AND hold_reason IS NULL`,
          [charge.id, reason, nowDate.toISOString()],
        );
        span?.setAttributes({ 'payments.charge.hold': true });
        return finish(false, { reason, heldForReview: true });
      }

      // 4 + 5. Guarded transition and the one ledger effect.
      const receipt = metadataItem(body, 'MpesaReceiptNumber');
      const paidAt = parseDarajaDate(metadataItem(body, 'TransactionDate')) ?? nowDate;
      const result = await applyChargeResolution(
        tx,
        charge,
        {
          outcome: 'paid',
          resultCode,
          resultDesc: cb.ResultDesc,
          receipt: receipt === undefined ? null : String(receipt),
          paidAt,
          resolvedBy: 'callback',
        },
        nowDate,
      );
      return finish(result.applied, { transition: result.transition, reason: result.reason });
    }

    // Any non-zero ResultCode is a definite decline from Daraja.
    const result = await applyChargeResolution(
      tx,
      charge,
      { outcome: 'failed', resultCode, resultDesc: cb.ResultDesc, resolvedBy: 'callback' },
      nowDate,
    );
    return finish(result.applied, { transition: result.transition, reason: result.reason });
  });
}
