/**
 * The charge side of the payment state machine: I2 and I5.
 *
 * I2 — one charge per sale. `charges.sale_id` is UNIQUE, and createCharge
 *      returns the existing row on a repeat rather than inserting. A repeat
 *      NEVER re-pushes to M-Pesa: if the first push reached Daraja and only
 *      the response was lost, a second push would prompt the customer twice.
 *
 * I5 — a timeout is not a decline. The STK push happens OUTSIDE the DB
 *      transaction (never hold a transaction across a network call), and the
 *      only thing a timeout or transport error changes is `last_push_error`.
 *      Status stays PENDING and checkout_request_id stays NULL: we never
 *      heard back, so we don't know. There is no code path from a timeout to
 *      FAILED. A synchronous 4xx rejection IS a definite answer — nothing was
 *      initiated — and that is the one path to FAILED from here.
 */
import { randomUUID } from 'node:crypto';
import { toMinorUnits } from '@tillflow/shared/money';
import {
  isUncertainOutcome,
  MpesaRejectedError,
  type MpesaAdapter,
  type StkPushAck,
} from '@tillflow/mpesa';
import type { Db } from '../db.js';
import { isUniqueViolation } from '../db.js';
import { rowToCharge, type Charge, type ChargeRow } from '../types.js';

export class ValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

export interface CreateChargeInput {
  saleId: string;
  tenantId: string;
  amountMinor: number;
  tenantTill: string;
  customerMsisdn: string;
  /** Forwarded to the adapter; only the fake / stub honour it. */
  scenarioHint?: string;
}

export interface CreateChargeOptions {
  db: Db;
  adapter: MpesaAdapter;
  callbackBaseUrl: string;
  now?: () => Date;
}

export interface CreateChargeResult {
  charge: Charge;
  created: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MSISDN_RE = /^2547\d{8}$|^2541\d{8}$/;

export function validateCreateCharge(body: unknown): CreateChargeInput {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('invalid_body', 'body must be a JSON object');
  }
  const b = body as Record<string, unknown>;

  const saleId = str(b, 'saleId');
  if (!UUID_RE.test(saleId)) throw new ValidationError('invalid_sale_id', 'saleId must be a UUID');

  const tenantId = str(b, 'tenantId');
  if (!UUID_RE.test(tenantId)) throw new ValidationError('invalid_tenant_id', 'tenantId must be a UUID');

  const tenantTill = str(b, 'tenantTill');
  if (!/^\d{5,7}$/.test(tenantTill)) {
    throw new ValidationError('invalid_till', 'tenantTill must be a 5–7 digit M-Pesa shortcode');
  }

  const customerMsisdn = str(b, 'customerMsisdn');
  if (!MSISDN_RE.test(customerMsisdn)) {
    throw new ValidationError('invalid_msisdn', 'customerMsisdn must be a Kenyan MSISDN like 2547XXXXXXXX');
  }

  let amountMinor: number;
  try {
    amountMinor = toMinorUnits(b['amountMinor']);
  } catch (err) {
    throw new ValidationError('invalid_amount', err instanceof Error ? err.message : 'invalid amount');
  }
  if (amountMinor <= 0) throw new ValidationError('invalid_amount', 'amountMinor must be greater than zero');
  if (amountMinor % 100 !== 0) {
    throw new ValidationError(
      'amount_not_whole_shillings',
      `M-Pesa charges whole shillings; ${amountMinor} minor units is KES ${amountMinor / 100}`,
    );
  }

  const hint = b['scenarioHint'];
  return {
    saleId,
    tenantId,
    amountMinor,
    tenantTill,
    customerMsisdn,
    ...(typeof hint === 'string' && hint !== '' ? { scenarioHint: hint } : {}),
  };
}

function str(b: Record<string, unknown>, key: string): string {
  const v = b[key];
  if (typeof v !== 'string' || v === '') throw new ValidationError(`missing_${snake(key)}`, `${key} is required`);
  return v;
}

function snake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// ---------------------------------------------------------------------------

export async function getChargeBySaleId(db: Db, saleId: string): Promise<Charge | null> {
  const res = await db.query<ChargeRow>('SELECT * FROM charges WHERE sale_id = $1', [saleId]);
  const row = res.rows[0];
  return row ? rowToCharge(row) : null;
}

export async function getCharge(db: Db, chargeId: string): Promise<Charge | null> {
  const res = await db.query<ChargeRow>('SELECT * FROM charges WHERE id = $1', [chargeId]);
  const row = res.rows[0];
  return row ? rowToCharge(row) : null;
}

/**
 * Create the charge for a sale and initiate the STK push. Idempotent on
 * saleId: a repeat returns the existing charge in whatever state it is in,
 * and never pushes again.
 */
export async function createCharge(
  input: CreateChargeInput,
  opts: CreateChargeOptions,
): Promise<CreateChargeResult> {
  const { db, adapter } = opts;
  const now = opts.now ?? (() => new Date());

  // Fast path: already exists. No push, no write.
  const existing = await getChargeBySaleId(db, input.saleId);
  if (existing) return { charge: existing, created: false };

  // Insert PENDING first, in its own short transaction, so that a concurrent
  // request for the same sale hits UNIQUE(sale_id) here — before either of
  // them has talked to M-Pesa.
  const id = randomUUID();
  const createdAt = now().toISOString();
  try {
    await db.query(
      `INSERT INTO charges (id, sale_id, tenant_id, amount_minor, till, customer_msisdn, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $7)`,
      [id, input.saleId, input.tenantId, input.amountMinor, input.tenantTill, input.customerMsisdn, createdAt],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      // The other request won. Return what it created; it owns the push.
      const winner = await getChargeBySaleId(db, input.saleId);
      if (winner) return { charge: winner, created: false };
    }
    throw err;
  }

  await pushStk(id, input, opts);

  const charge = await getCharge(db, id);
  if (!charge) throw new Error(`charge ${id} vanished after insert`);
  return { charge, created: true };
}

/**
 * One STK push attempt for a charge. Records the ack, or the reason we have
 * none. Exported so the runbook's explicit re-push (an operator decision,
 * never automatic) can reuse it.
 */
export async function pushStk(chargeId: string, input: CreateChargeInput, opts: CreateChargeOptions): Promise<void> {
  const { db, adapter } = opts;
  const now = opts.now ?? (() => new Date());

  await db.query('UPDATE charges SET stk_attempts = stk_attempts + 1, updated_at = $2 WHERE id = $1', [
    chargeId,
    now().toISOString(),
  ]);

  let ack: StkPushAck;
  try {
    ack = await adapter.stkPush({
      amountMinor: toMinorUnits(input.amountMinor),
      phoneNumber: input.customerMsisdn,
      shortCode: input.tenantTill,
      // Daraja caps AccountReference at 12 chars; enough of the sale id to
      // find it again from a statement line.
      accountReference: `TF${input.saleId.replace(/-/g, '').slice(0, 10)}`,
      transactionDesc: 'TillFlow sale',
      callbackUrl: `${opts.callbackBaseUrl}/callbacks/stk`,
      ...(input.scenarioHint !== undefined ? { scenarioHint: input.scenarioHint } : {}),
    });
  } catch (err) {
    if (isUncertainOutcome(err)) {
      // I5. We do not know what happened. Stay PENDING; the reconciler and
      // the runbook own this from here. No transition.
      await db.query('UPDATE charges SET last_push_error = $2, updated_at = $3 WHERE id = $1', [
        chargeId,
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        now().toISOString(),
      ]);
      return;
    }
    if (err instanceof MpesaRejectedError) {
      // Definite: Daraja refused to initiate. Nothing is in flight.
      const ts = now().toISOString();
      await db.query(
        `UPDATE charges
         SET status = 'FAILED', result_code = $2, result_desc = $3, last_push_error = $3, failed_at = $4, updated_at = $4
         WHERE id = $1 AND status = 'PENDING'`,
        [chargeId, Number(err.responseCode) || null, `rejected: ${err.message}`, ts],
      );
      return;
    }
    throw err;
  }

  await db.query(
    `UPDATE charges SET merchant_request_id = $2, checkout_request_id = $3, last_push_error = NULL, updated_at = $4
     WHERE id = $1`,
    [chargeId, ack.merchantRequestId, ack.checkoutRequestId, now().toISOString()],
  );
}
