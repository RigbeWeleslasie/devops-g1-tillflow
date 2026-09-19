/**
 * The sale state machine and its idempotency guarantee (I1).
 *
 * I1: one sale per (tenant, idempotency key). A duplicate POST /sales with
 * the same body replays the first response byte-for-byte and creates no
 * second row; the same key with a different body is a 409. Handled
 * correctly under a genuine race (two identical requests landing at once),
 * not just for sequential retries -- see createSale's unique-violation catch.
 */
import { randomUUID, createHash } from 'node:crypto';
import type { Db } from '../db.js';
import { withTransaction, isUniqueViolation } from '../db.js';
import { lineItemTotal, sumMinor, toMinorUnits, type MinorUnits } from '@tillflow/shared/money';
import type { Sale, SaleItem, SaleStatus } from '../types.js';
import type { PaymentsClient } from './paymentsClient.js';
import type { SalePaidEvent } from '@tillflow/shared/events';
import { recordSaleWrite } from '../metrics.js';

export class NotFoundError extends Error {}
export class IdempotencyConflictError extends Error {}
export class InvalidStateError extends Error {}
export class ValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

/** Matches Payments' validateCreateCharge — STK Push needs a real Kenyan MSISDN. */
const CUSTOMER_MSISDN_RE = /^2547\d{8}$|^2541\d{8}$/;

export interface CreateSaleItemInput {
  productId: string;
  quantity: number;
}

export interface CreateSaleResult {
  status: number;
  body: Sale;
}

function canonicalHash(value: unknown): string {
  // Deterministic regardless of key order in the original request body.
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
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function rowToSale(row: {
  id: string;
  tenant_id: string;
  attendant_id: string;
  status: SaleStatus;
  total_minor: number;
  charge_id: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
}, items: SaleItem[]): Sale {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    attendantId: row.attendant_id,
    status: row.status,
    totalMinor: row.total_minor,
    chargeId: row.charge_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    items,
  };
}

export async function createSale(
  db: Db,
  tenantId: string,
  attendantId: string,
  items: CreateSaleItemInput[],
  idempotencyKey: string,
): Promise<CreateSaleResult> {
  const requestHash = canonicalHash({ tenantId, attendantId, items });

  const existing = await db.query<{
    request_hash: string;
    response_status: number;
    response_body: string;
  }>(
    'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE tenant_id = $1 AND idempotency_key = $2',
    [tenantId, idempotencyKey],
  );

  const existingRow = existing.rows[0];
  if (existingRow) {
    if (existingRow.request_hash !== requestHash) {
      throw new IdempotencyConflictError(
        `Idempotency-Key ${idempotencyKey} was already used with a different request body`,
      );
    }
    recordSaleWrite('idempotent');
    return { status: existingRow.response_status, body: JSON.parse(existingRow.response_body) as Sale };
  }

  if (items.length === 0) {
    throw new InvalidStateError('a sale needs at least one line item');
  }

  try {
    const result = await withTransaction(db, async (client) => {
      const attendantResult = await client.query<{ id: string }>(
        'SELECT id FROM attendants WHERE id = $1 AND tenant_id = $2',
        [attendantId, tenantId],
      );
      if (attendantResult.rowCount === 0) {
        throw new NotFoundError(`attendant ${attendantId} not found for this tenant`);
      }

      const saleId = randomUUID();
      const now = new Date().toISOString();

      // Pass 1: resolve every product and compute totals. Read-only — no
      // writes yet, so a missing product aborts before anything (sale row
      // included) exists to clean up.
      const resolved: Array<{ itemId: string; productId: string; quantity: number; unitPriceMinor: MinorUnits }> =
        [];
      const lineTotals: MinorUnits[] = [];
      for (const item of items) {
        const productResult = await client.query<{ id: string; unit_price_minor: number }>(
          'SELECT id, unit_price_minor FROM products WHERE id = $1 AND tenant_id = $2 AND active = true',
          [item.productId, tenantId],
        );
        const product = productResult.rows[0];
        if (!product) {
          throw new NotFoundError(`product ${item.productId} not found for this tenant`);
        }
        const unitPriceMinor = toMinorUnits(product.unit_price_minor);
        lineTotals.push(lineItemTotal(unitPriceMinor, item.quantity));
        resolved.push({
          itemId: randomUUID(),
          productId: product.id,
          quantity: item.quantity,
          unitPriceMinor,
        });
      }

      // Server recomputes the total from the catalog price at write time --
      // the client's request never carries a price or a total.
      const totalMinor = sumMinor(lineTotals);

      // Pass 2: the sale row must exist before sale_items can reference it
      // (sale_items.sale_id -> sales.id).
      await client.query(
        `INSERT INTO sales (id, tenant_id, attendant_id, status, total_minor, created_at, updated_at)
         VALUES ($1, $2, $3, 'UNPAID', $4, $5, $5)`,
        [saleId, tenantId, attendantId, totalMinor, now],
      );

      const resolvedItems: SaleItem[] = [];
      for (const r of resolved) {
        await client.query(
          'INSERT INTO sale_items (id, sale_id, product_id, quantity, unit_price_minor) VALUES ($1, $2, $3, $4, $5)',
          [r.itemId, saleId, r.productId, r.quantity, r.unitPriceMinor],
        );
        resolvedItems.push({
          id: r.itemId,
          saleId,
          productId: r.productId,
          quantity: r.quantity,
          unitPriceMinor: r.unitPriceMinor,
        });
      }

      const sale = rowToSale(
        {
          id: saleId,
          tenant_id: tenantId,
          attendant_id: attendantId,
          status: 'UNPAID',
          total_minor: totalMinor,
          charge_id: null,
          created_at: now,
          updated_at: now,
          paid_at: null,
        },
        resolvedItems,
      );

      const responseStatus = 201;
      await client.query(
        `INSERT INTO idempotency_keys (tenant_id, idempotency_key, request_hash, sale_id, response_status, response_body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, idempotencyKey, requestHash, saleId, responseStatus, JSON.stringify(sale)],
      );

      return { status: responseStatus, body: sale };
    });
    recordSaleWrite('ok');
    return result;
  } catch (err) {
    // A concurrent request for the SAME key won this race and committed
    // first: this transaction's own idempotency_keys insert hit the primary
    // key and rolled back (the sale it tried to create never persisted).
    // Re-read what actually won and return THAT, rather than surfacing the
    // race as an error to the caller.
    if (isUniqueViolation(err)) {
      const winner = await db.query<{
        request_hash: string;
        response_status: number;
        response_body: string;
      }>(
        'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE tenant_id = $1 AND idempotency_key = $2',
        [tenantId, idempotencyKey],
      );
      const row = winner.rows[0];
      if (row) {
        if (row.request_hash !== requestHash) {
          throw new IdempotencyConflictError(
            `Idempotency-Key ${idempotencyKey} was already used with a different request body`,
          );
        }
        recordSaleWrite('unique_violation');
        return { status: row.response_status, body: JSON.parse(row.response_body) as Sale };
      }
    }
    throw err;
  }
}

export async function getSale(db: Db, tenantId: string, saleId: string): Promise<Sale | null> {
  // Scoped by tenant_id in the WHERE clause, not checked after the fact: a
  // row belonging to another tenant simply doesn't match, so the caller sees
  // exactly the same "not found" as a truly nonexistent id. That's the IDOR
  // requirement -- a 404, never a 403 that would confirm the id exists.
  const saleResult = await db.query<{
    id: string;
    tenant_id: string;
    attendant_id: string;
    status: SaleStatus;
    total_minor: number;
    charge_id: string | null;
    created_at: string;
    updated_at: string;
    paid_at: string | null;
  }>('SELECT * FROM sales WHERE id = $1 AND tenant_id = $2', [saleId, tenantId]);

  const row = saleResult.rows[0];
  if (!row) return null;

  const itemsResult = await db.query<{
    id: string;
    sale_id: string;
    product_id: string;
    quantity: number;
    unit_price_minor: number;
  }>('SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY created_at', [saleId]);

  const items: SaleItem[] = itemsResult.rows.map((r) => ({
    id: r.id,
    saleId: r.sale_id,
    productId: r.product_id,
    quantity: r.quantity,
    unitPriceMinor: r.unit_price_minor,
  }));

  return rowToSale(row, items);
}

export interface PaySaleResult {
  sale: Sale;
  charge: { status: 'PENDING' | 'UNKNOWN'; chargeId: string | null };
}

export async function paySale(
  db: Db,
  paymentsClient: PaymentsClient,
  tenantId: string,
  saleId: string,
  customerMsisdn: string,
): Promise<PaySaleResult> {
  const sale = await getSale(db, tenantId, saleId);
  if (!sale) {
    throw new NotFoundError(`sale ${saleId} not found`);
  }
  if (sale.status === 'PAID') {
    throw new InvalidStateError('sale is already paid');
  }
  if (sale.status === 'VOID') {
    throw new InvalidStateError('sale has been voided');
  }
  if (sale.status !== 'UNPAID') {
    throw new InvalidStateError(`sale is not payable in status ${sale.status}`);
  }

  // Already initiated (a prior /pay call got a chargeId) -- idempotent no-op,
  // no second call to Payments. Payments' own idempotency-on-saleId would
  // make a second call safe too, but there is no reason to make it.
  if (sale.chargeId) {
    return { sale, charge: { status: 'PENDING', chargeId: sale.chargeId } };
  }

  if (!CUSTOMER_MSISDN_RE.test(customerMsisdn)) {
    throw new ValidationError(
      'invalid_customer_msisdn',
      'customerMsisdn must be a Kenyan MSISDN like 2547XXXXXXXX',
    );
  }

  const tenantResult = await db.query<{ till_number: string }>(
    'SELECT till_number FROM tenants WHERE id = $1',
    [tenantId],
  );
  const tillNumber = tenantResult.rows[0]?.till_number;
  if (!tillNumber) {
    throw new NotFoundError(`tenant ${tenantId} not found`);
  }

  const result = await paymentsClient.createCharge({
    saleId: sale.id,
    tenantId,
    amountMinor: sale.totalMinor,
    tenantTill: tillNumber,
    customerMsisdn,
  });

  if (result.outcome === 'unknown') {
    // The HTTP call to Payments itself timed out or failed. The sale stays
    // UNPAID with no chargeId — safe to retry /pay, and NOT reported as a
    // failure, matching "a timeout leaves the charge PENDING, never FAILED"
    // one level up: POS never invents a FAILED state Payments didn't report.
    return { sale, charge: { status: 'UNKNOWN', chargeId: null } };
  }

  await db.query('UPDATE sales SET charge_id = $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4', [
    result.chargeId,
    new Date().toISOString(),
    saleId,
    tenantId,
  ]);

  return {
    sale: { ...sale, chargeId: result.chargeId },
    charge: { status: 'PENDING', chargeId: result.chargeId },
  };
}

/**
 * The ONLY path that sets a sale to PAID (docs/architecture.md §4.1). Called
 * by the sale.paid consumer, never by an HTTP route.
 *
 * Idempotent on sale_id via sale_paid_events: a redelivered or duplicated
 * event is a no-op the second time, at any order or repetition count.
 */
export async function applySalePaid(db: Db, event: SalePaidEvent): Promise<void> {
  await withTransaction(db, async (client) => {
    const dedupe = await client.query(
      'INSERT INTO sale_paid_events (sale_id, event_id) VALUES ($1, $2) ON CONFLICT (sale_id) DO NOTHING RETURNING sale_id',
      [event.data.saleId, event.eventId],
    );
    if (dedupe.rowCount === 0) {
      // Already applied by an earlier delivery of this (or another) event
      // for the same sale — no second transition, no second effect.
      return;
    }

    await client.query(
      `UPDATE sales
       SET status = 'PAID', paid_at = $1, updated_at = $1
       WHERE id = $2 AND tenant_id = $3 AND status != 'PAID'`,
      [event.data.paidAt, event.data.saleId, event.data.tenantId],
    );
  });
}
