import type { Db } from '../src/db.js';
import { bootstrapTenant, createAttendant, createProduct } from '../src/services/tenantService.js';

export async function seedTenant(db: Db, opts?: { productPriceMinor?: number }) {
  const { tenant, owner } = await bootstrapTenant(db, {
    name: 'Test Shop',
    tillNumber: '123456',
    ownerExternalAuthId: 'owner-auth-id',
    ownerDisplayName: 'Test Owner',
  });
  const attendant = await createAttendant(db, tenant.id, {
    externalAuthId: 'attendant-auth-id',
    displayName: 'Test Attendant',
    msisdn: '254700000000',
  });
  const product = await createProduct(db, tenant.id, {
    name: 'Widget',
    unitPriceMinor: opts?.productPriceMinor ?? 250,
  });
  return { tenant, owner, attendant, product };
}
