/**
 * Tenant setup: bootstrapping a tenant + its first owner, and the
 * owner-only routes that follow (attendants, commission rates, products).
 *
 * bootstrapTenant is the one unauthenticated write in this service — there
 * is no user yet to authenticate as when a tenant is being created for the
 * first time. Everything after it requires a token minted for the owner it
 * returns.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { withTransaction } from '../db.js';
import { toMinorUnits } from '@tillflow/shared/money';
import type { Attendant, Product, Tenant, User } from '../types.js';

export class NotFoundError extends Error {}
export class ValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

export interface BootstrapTenantInput {
  name: string;
  tillNumber: string;
  ownerExternalAuthId: string;
  ownerDisplayName: string;
}

export async function bootstrapTenant(
  db: Db,
  input: BootstrapTenantInput,
): Promise<{ tenant: Tenant; owner: User }> {
  return withTransaction(db, async (client) => {
    const tenantId = randomUUID();
    const now = new Date().toISOString();
    await client.query(
      'INSERT INTO tenants (id, name, till_number, created_at) VALUES ($1, $2, $3, $4)',
      [tenantId, input.name, input.tillNumber, now],
    );

    const ownerId = randomUUID();
    await client.query(
      `INSERT INTO users (id, tenant_id, external_auth_id, role, display_name)
       VALUES ($1, $2, $3, 'owner', $4)`,
      [ownerId, tenantId, input.ownerExternalAuthId, input.ownerDisplayName],
    );

    return {
      tenant: { id: tenantId, name: input.name, tillNumber: input.tillNumber, createdAt: now },
      owner: {
        id: ownerId,
        tenantId,
        externalAuthId: input.ownerExternalAuthId,
        role: 'owner',
        displayName: input.ownerDisplayName,
      },
    };
  });
}

export interface CreateAttendantInput {
  externalAuthId: string;
  displayName: string;
  /** MSISDN for B2C payout. Owner-managed only — never taken from the attendant's own request (threat-model.md A7). */
  msisdn: string;
}

export async function createAttendant(
  db: Db,
  tenantId: string,
  input: CreateAttendantInput,
): Promise<Attendant> {
  return withTransaction(db, async (client) => {
    const userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, tenant_id, external_auth_id, role, display_name)
       VALUES ($1, $2, $3, 'attendant', $4)`,
      [userId, tenantId, input.externalAuthId, input.displayName],
    );
    const attendantId = randomUUID();
    await client.query(
      'INSERT INTO attendants (id, tenant_id, user_id, msisdn) VALUES ($1, $2, $3, $4)',
      [attendantId, tenantId, userId, input.msisdn],
    );
    return { id: attendantId, tenantId, userId, msisdn: input.msisdn };
  });
}

export interface CreateCommissionRateInput {
  attendantId?: string | undefined; // omit for the tenant default rate
  rateBps: number;
}

export async function setCommissionRate(
  db: Db,
  tenantId: string,
  input: CreateCommissionRateInput,
): Promise<{ id: string; tenantId: string; attendantId: string | null; rateBps: number }> {
  if (input.attendantId) {
    const check = await db.query('SELECT id FROM attendants WHERE id = $1 AND tenant_id = $2', [
      input.attendantId,
      tenantId,
    ]);
    if (check.rowCount === 0) {
      throw new NotFoundError(`attendant ${input.attendantId} not found for this tenant`);
    }
  }
  const id = randomUUID();
  await db.query(
    'INSERT INTO commission_rates (id, tenant_id, attendant_id, rate_bps) VALUES ($1, $2, $3, $4)',
    [id, tenantId, input.attendantId ?? null, input.rateBps],
  );
  return { id, tenantId, attendantId: input.attendantId ?? null, rateBps: input.rateBps };
}

export interface CreateProductInput {
  name: string;
  unitPriceMinor: number;
}

export async function createProduct(
  db: Db,
  tenantId: string,
  input: CreateProductInput,
): Promise<Product> {
  const unitPriceMinor = toMinorUnits(input.unitPriceMinor);
  if (unitPriceMinor % 100 !== 0) {
    throw new ValidationError(
      'price_not_whole_shillings',
      `M-Pesa cannot carry cents; unitPriceMinor must be a multiple of 100 (got ${unitPriceMinor})`,
    );
  }
  const id = randomUUID();
  await db.query(
    'INSERT INTO products (id, tenant_id, name, unit_price_minor, active) VALUES ($1, $2, $3, $4, true)',
    [id, tenantId, input.name, unitPriceMinor],
  );
  return { id, tenantId, name: input.name, unitPriceMinor, active: true };
}

export async function getTenant(db: Db, tenantId: string): Promise<Tenant | null> {
  const result = await db.query<{ id: string; name: string; till_number: string; created_at: string }>(
    'SELECT * FROM tenants WHERE id = $1',
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, name: row.name, tillNumber: row.till_number, createdAt: row.created_at };
}
