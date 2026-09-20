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
import { metadataItem, STK_RESULT, type MpesaAdapter, type StkCallbackBody } from '@tillflow/mpesa';
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
  /** What the confirming stkQuery said. See ConfirmationVerdict. */
  confirmation: ConfirmationVerdict;
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
  /**
   * Daraja, for the confirming query. Omitted -> confirmation is skipped and
   * a success callback is trusted on its own, which is the pre-G5 behaviour.
   */
  adapter?: MpesaAdapter;
  /**
   * Ask Daraja to confirm before any PENDING->PAID transition. Defaults on
   * when an adapter is supplied. The switch exists so an operator can turn it
   * off during a Daraja query-API outage (docs/runbook.md) rather than having
   * every legitimate payment wait for the reconciler -- a deliberate,
   * logged, temporary trade of integrity for availability, not a default.
   */
  confirmBeforePaid?: boolean;
}

/**
 * What Daraja said when we asked whether this payment really succeeded.
 *
 * - `confirmed`     Daraja agrees: result code 0. Safe to pay.
 * - `contradicted`  Daraja has a TERMINAL answer and it is not success. The
 *                   callback claims money moved and the provider says it did
 *                   not. Nothing legitimate produces this, so the charge is
 *                   held for a human rather than resolved either way.
 * - `unconfirmed`   Daraja does not know yet, or we could not reach it. Not
 *                   evidence of anything. The charge stays PENDING and the
 *                   reconciler owns it -- the same place a timed-out push
 *                   already ends up (I5).
 * - `skipped`       No adapter, or confirmation switched off.
 * - `not-required`  Not a success callback; there is no PAID transition to
 *                   guard.
 */
export type ConfirmationVerdict =
  | 'confirmed'
  | 'contradicted'
  | 'unconfirmed'
  | 'skipped'
  | 'not-required';

export interface Confirmation {
  verdict: ConfirmationVerdict;
  detail: string | null;
}

/**
 * Close the forged-callback hole (docs/threat-model.md, residual risk owned by
 * Payments and expiring at G5).
 *
 * Until now a callback was accepted on two checks: the CheckoutRequestID
 * matches a charge we issued, and the amount matches ours. Both are values an
 * attacker can learn or guess, and the callback endpoint is unauthenticated by
 * necessity -- Safaricom cannot send our service token. So a forged POST with a
 * live reference and the right amount moved a sale to PAID and wrote a
 * `sale.paid` event, with no money behind it.
 *
 * The fix is to stop treating the callback as evidence. It is a NOTIFICATION;
 * the provider's own records are the evidence. Before any PAID transition we
 * ask Daraja directly, over a channel an attacker does not control, and the
 * callback only tells us when to ask.
 *
 * ## Why this runs outside the transaction
 *
 * The discipline everywhere else in this service: never hold a transaction
 * across a network call. It also has to run BEFORE the transaction rather than
 * splitting it in two -- the callback_events insert both dedupes and records,
 * so a crash between "recorded" and "applied" would leave a redelivery deduped
 * against a callback that was never applied, and the payment would be lost.
 * One transaction, decided with the answer already in hand.
 *
 * ## Why it does not query for every callback
 *
 * The endpoint is open to the internet, so anything it does on an attacker's
 * behalf is an amplifier. The cheap pre-check below means a forged reference we
 * never issued costs one indexed SELECT and no Daraja call at all. It also
 * covers the adoption path -- a charge whose push timed out has no
 * CheckoutRequestID of its own, and that is the weakest matching rule we have,
 * so it is the last one that should go unconfirmed.
 */
async function confirmSuccess(
  body: StkCallbackBody,
  opts: ApplyOptions,
  at: Date,
): Promise<Confirmation> {
  const cb = body.Body.stkCallback;
  if (cb.ResultCode !== STK_RESULT.SUCCESS) return { verdict: 'not-required', detail: null };

  const enabled = opts.confirmBeforePaid ?? opts.adapter !== undefined;
  if (!opts.adapter || !enabled) {
    return { verdict: 'skipped', detail: 'confirmation disabled' };
  }

  // Is there anything this callback could plausibly move? Either a charge
  // already holding this reference, or one whose push timed out and that
  // adoption would reach. If neither, the callback is unmatched and will be
  // recorded as such -- no reason to spend a Daraja call on it.
  const reportedKes = Number(metadataItem(body, 'Amount'));
  const reportedMinor = Number.isFinite(reportedKes) ? Math.round(reportedKes * 100) : -1;
  const phone = String(metadataItem(body, 'PhoneNumber') ?? '');
  const since = new Date(at.getTime() - ADOPTION_WINDOW_MS).toISOString();

  const candidate = await opts.db.query<{ n: number }>(
    `SELECT 1 AS n FROM charges
     WHERE status = 'PENDING'
       AND hold_reason IS NULL
       AND (checkout_request_id = $1
            OR (checkout_request_id IS NULL AND amount_minor = $2 AND customer_msisdn = $3 AND created_at >= $4))
     LIMIT 1`,
    [cb.CheckoutRequestID, reportedMinor, phone, since],
  );
  if (candidate.rowCount === 0) {
    return { verdict: 'not-required', detail: 'no PENDING charge this callback could move' };
  }

  try {
    const result = await opts.adapter.stkQuery(cb.CheckoutRequestID);
    if (result.status === 'pending') {
      return {
        verdict: 'unconfirmed',
        detail: 'Daraja reports the transaction is still processing',
      };
    }
    if (result.resultCode === STK_RESULT.SUCCESS) {
      return { verdict: 'confirmed', detail: null };
    }
    return {
      verdict: 'contradicted',
      detail:
        `callback claims success but stkQuery reports ResultCode ${result.resultCode} ` +
        `(${result.resultDesc || 'no description'})`,
    };
  } catch (err) {
    // Unreachable is not an answer. Treat it exactly like a timed-out push:
    // stay PENDING, let the reconciler find out. Never pay on a failed check,
    // and never fail on one either (I5).
    return {
      verdict: 'unconfirmed',
      detail: `stkQuery failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function applyStkCallback(body: StkCallbackBody, opts: ApplyOptions): Promise<CallbackOutcome> {
  const now = opts.now ?? (() => new Date());
  const cb = body.Body.stkCallback;
  const reference = cb.CheckoutRequestID;
  const resultCode = cb.ResultCode;
  const checksum = callbackChecksum(body);
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'mpesa.checkout_request_id': reference, 'mpesa.result_code': resultCode });

  // Ask Daraja first, outside any transaction, and carry the answer in.
  const confirmation = await confirmSuccess(body, opts, now());
  span?.setAttributes({ 'payments.callback.confirmation': confirmation.verdict });

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
      confirmation: confirmation.verdict,
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

      // 3b. The provider's own records, not the callback's word for it.
      //     This is the G5 close on the forged-callback risk: everything above
      //     checks values an attacker can guess, and this is the one check
      //     that needs a channel they do not control.
      if (confirmation.verdict === 'contradicted') {
        // The callback says paid, Daraja says otherwise. Nothing legitimate
        // produces this, so it is the strongest forgery signal we have —
        // recorded in callback_events, logged, and metered as `contradicted`,
        // which is the label that should page.
        //
        // But deliberately NOT a hold, and not a FAILED transition. A hold
        // freezes the charge until a human clears it, which would hand anyone
        // who can guess a live CheckoutRequestID and its amount a
        // denial-of-service lever over that sale — punishing the customer for
        // the attacker's message. Refusing is enough: the forgery changes no
        // state at all, and the real callback (or the reconciler) still
        // resolves the charge correctly afterwards. A forged callback should
        // be a no-op, not an incident for the person trying to pay.
        span?.setAttributes({ 'payments.callback.contradicted': true });
        return finish(false, { reason: confirmation.detail });
      }
      if (confirmation.verdict === 'unconfirmed') {
        // Not evidence of anything -- Daraja is slow or unreachable. The
        // charge stays PENDING and the reconciler resolves it, exactly as a
        // timed-out push already does (I5). Not a hold: nothing here needs a
        // human, and holding would stop the reconciler from finishing the job.
        return finish(false, { reason: confirmation.detail });
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
