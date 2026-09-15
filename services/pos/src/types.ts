export type SaleStatus = 'DRAFT' | 'OPEN' | 'UNPAID' | 'PAID' | 'VOID';
export type UserRole = 'owner' | 'attendant';

export interface Tenant {
  id: string;
  name: string;
  tillNumber: string;
  createdAt: string;
}

export interface User {
  id: string;
  tenantId: string;
  externalAuthId: string;
  role: UserRole;
  displayName: string;
}

export interface Attendant {
  id: string;
  tenantId: string;
  userId: string;
  msisdn: string;
}

export interface Product {
  id: string;
  tenantId: string;
  name: string;
  unitPriceMinor: number;
  active: boolean;
}

export interface SaleItem {
  id: string;
  saleId: string;
  productId: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface Sale {
  id: string;
  tenantId: string;
  attendantId: string;
  status: SaleStatus;
  totalMinor: number;
  chargeId: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  items: SaleItem[];
}

/** The authenticated caller, attached to every request by the auth plugin. Tenant scoping for every route flows from THIS, never from a path/body param. */
export interface Principal {
  tenantId: string;
  userId: string;
  role: UserRole;
}
