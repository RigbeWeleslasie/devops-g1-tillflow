/**
 * The payout side: B2C disbursement, idempotent on ledger_id (I4's second
 * half). The commission worker computes WHAT to pay and records it in
 * payout_ledger; this service is the only thing that moves the money.
 *
 * I4 — one payout per ledger row. `payouts.ledger_id` is UNIQUE, and
 *      createPayout returns the existing row on a repeat rather than
 *      sending B2C again. Combined with the ledger's
 *      UNIQUE(tenant_id, attendant_id, business_day), re-running the daily
 *      close can produce neither a second ledger row nor a second payment.
 *      Duplicate disbursement = 0.
 *
 * I5 — identical to charges: a B2C request that times out leaves the payout
 *      PENDING with no conversation_id. Never FAILED. Re-sending on a guess
 *      is how an attendant gets paid twice, so it does not happen
 *      automatically — the B2C result callback or an operator resolves it.
 *
 * Amounts: B2C pays whole shillings. The ledger already stores payout_minor
 * floored to a shilling with the remainder recorded, so anything reaching
 * here should be exact; it is re-checked anyway, because this is the last
 * gate before money leaves.
 */
import { randomUUID } from 'node:crypto';
import { toMinorUnits } from '@tillflow/shared/money';
import { isUncertainOutcome, MpesaRejectedError, type B2CAck, type MpesaAdapter } from '@tillflow/mpesa';
import type { Db } from '../db.js';
import { isUniqueViolation } from '../db.js';
import { ValidationError } from './chargeService.js';

export type PayoutStatus = 'PENDING' | 'PAID' | 'FAILED';

export interface PayoutRow {
  id: string;
  ledger_id: string;
  tenant_id: string;
  amount_minor: number;
  msisdn: string;
  status: PayoutStatus;
  originator_conversation_id: string;
  conversation_id: string | null;
  b2c_attempts: number;
  last_request_error: string | null;
  transaction_id: string | null;
  result_code: number | null;
  result_desc: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  paid_at: string | Date | null;
  failed_at: string | Date | null;
}

export interface PayoutResponse {
  payoutId: string;
  ledgerId: string;
  status: PayoutStatus;
  amountMinor: number;
  conversationId: string | null;
  /** True when this call created the payout; false when it returned an existing one (I4). */
  created: boolean;
}

export function toPayoutResponse(row: PayoutRow, created: boolean): PayoutResponse {
  return {
    payoutId: row.id,
    ledgerId: row.ledger_id,
    status: row.status,
    amountMinor: row.amount_minor,
    conversationId: row.conversation_id,
    created,
  };
}

export interface CreatePayoutInput {
  ledgerId: string;
  scenarioHint?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateCreatePayout(body: unknown): CreatePayoutInput {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('invalid_body', 'body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  const ledgerId = b['ledgerId'];
  if (typeof ledgerId !== 'string' || ledgerId === '') {
    throw new ValidationError('missing_ledger_id', 'ledgerId is required');
  }
  if (!UUID_RE.test(ledgerId)) {
    throw new ValidationError('invalid_ledger_id', 'ledgerId must be a UUID');
  }
  const hint = b['scenarioHint'];
  return { ledgerId, ...(typeof hint === 'string' && hint !== '' ? { scenarioHint: hint } : {}) };
}

export interface PayoutOptions {
  db: Db;
  adapter: MpesaAdapter;
  callbackBaseUrl: string;
  now?: () => Date;
}

export async function getPayoutByLedgerId(db: Db, ledgerId: string): Promise<PayoutRow | null> {
  const res = await db.query<PayoutRow>('SELECT * FROM payouts WHERE ledger_id = $1', [ledgerId]);
  return res.rows[0] ?? null;
}

export async function getPayout(db: Db, payoutId: string): Promise<PayoutRow | null> {
  const res = await db.query<PayoutRow>('SELECT * FROM payouts WHERE id = $1', [payoutId]);
  return res.rows[0] ?? null;
}

interface LedgerRow {
  id: string;
  tenant_id: string;
  attendant_id: string;
  business_day: string;
  payout_minor: number;
  msisdn: string;
  status: string;
}

export class LedgerNotFoundError extends Error {}

/**
 * Request the B2C disbursement for a ledger row. Idempotent on ledgerId: a
 * repeat returns the existing payout and sends nothing.
 */
export async function createPayout(
  input: CreatePayoutInput,
  opts: PayoutOptions,
): Promise<{ payout: PayoutRow; created: boolean }> {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());

  // Fast path: already requested. No send, no write.
  const existing = await getPayoutByLedgerId(db, input.ledgerId);
  if (existing) return { payout: existing, created: false };

  const ledgerRes = await db.query<LedgerRow>('SELECT * FROM payout_ledger WHERE id = $1', [input.ledgerId]);
  const ledger = ledgerRes.rows[0];
  if (!ledger) throw new LedgerNotFoundError(`payout_ledger ${input.ledgerId} not found`);

  if (ledger.payout_minor <= 0) {
    throw new ValidationError('nothing_to_pay', `ledger ${ledger.id} has a zero payout`);
  }
  if (ledger.payout_minor % 100 !== 0) {
    // The ledger should already have floored this. Refuse rather than round:
    // this is the last gate before money leaves.
    throw new ValidationError(
      'amount_not_whole_shillings',
      `payout_minor ${ledger.payout_minor} is not a whole number of shillings`,
    );
  }

  // The payout id doubles as Daraja's OriginatorConversationID, so the
  // result callback can find this row even if we never learn the
  // ConversationID (a timed-out request never returns one).
  const id = randomUUID();
  const ts = now().toISOString();
  try {
    await db.query(
      `INSERT INTO payouts (id, ledger_id, tenant_id, amount_minor, msisdn, status, originator_conversation_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $7)`,
      [id, ledger.id, ledger.tenant_id, ledger.payout_minor, ledger.msisdn, id, ts],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await getPayoutByLedgerId(db, input.ledgerId);
      if (winner) return { payout: winner, created: false };
    }
    throw err;
  }

  await db.query(
    `UPDATE payout_ledger SET status = 'REQUESTED', updated_at = $2 WHERE id = $1 AND status = 'COMPUTED'`,
    [ledger.id, ts],
  );

  await sendB2C(id, ledger, input.scenarioHint, opts);

  const payout = await getPayout(db, id);
  if (!payout) throw new Error(`payout ${id} vanished after insert`);
  return { payout, created: true };
}

async function sendB2C(
  payoutId: string,
  ledger: LedgerRow,
  scenarioHint: string | undefined,
  opts: PayoutOptions,
): Promise<void> {
  const { db, adapter } = opts;
  const now = opts.now ?? (() => new Date());

  await db.query('UPDATE payouts SET b2c_attempts = b2c_attempts + 1, updated_at = $2 WHERE id = $1', [
    payoutId,
    now().toISOString(),
  ]);

  let ack: B2CAck;
  try {
    ack = await adapter.b2cPayment({
      amountMinor: toMinorUnits(ledger.payout_minor),
      phoneNumber: ledger.msisdn,
      originatorConversationId: payoutId,
      remarks: `TillFlow commission ${ledger.business_day}`,
      resultUrl: `${opts.callbackBaseUrl}/callbacks/b2c`,
      timeoutUrl: `${opts.callbackBaseUrl}/callbacks/b2c-timeout`,
      ...(scenarioHint !== undefined ? { scenarioHint } : {}),
    });
  } catch (err) {
    if (isUncertainOutcome(err)) {
      // I5. The request may have reached Daraja and the money may be moving.
      // PENDING, and nothing re-sends on its own — that is how someone gets
      // paid twice.
      await db.query('UPDATE payouts SET last_request_error = $2, updated_at = $3 WHERE id = $1', [
        payoutId,
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        now().toISOString(),
      ]);
      return;
    }
    if (err instanceof MpesaRejectedError) {
      // Definite: nothing was initiated, no money moved.
      const ts = now().toISOString();
      await db.query(
        `UPDATE payouts
         SET status = 'FAILED', result_code = $2, result_desc = $3, last_request_error = $3, failed_at = $4, updated_at = $4
         WHERE id = $1 AND status = 'PENDING'`,
        [payoutId, Number(err.responseCode) || null, `rejected: ${err.message}`, ts],
      );
      await db.query(
        `UPDATE payout_ledger SET status = 'FAILED', updated_at = $2 WHERE id = $1 AND status IN ('COMPUTED', 'REQUESTED')`,
        [ledger.id, ts],
      );
      return;
    }
    throw err;
  }

  await db.query(
    'UPDATE payouts SET conversation_id = $2, last_request_error = NULL, updated_at = $3 WHERE id = $1',
    [payoutId, ack.conversationId, now().toISOString()],
  );
}
