/**
 * Domain types for the Payments service. Column names are snake_case in
 * SQL and camelCase here; the row -> type mapping lives next to each query.
 */

export type ChargeStatus = 'PENDING' | 'PAID' | 'FAILED';
export type PayoutStatus = 'PENDING' | 'PAID' | 'FAILED';
export type LedgerStatus = 'COMPUTED' | 'REQUESTED' | 'PAID' | 'FAILED' | 'SKIPPED';

export interface Charge {
  id: string;
  saleId: string;
  tenantId: string;
  amountMinor: number;
  till: string;
  customerMsisdn: string;
  status: ChargeStatus;
  merchantRequestId: string | null;
  checkoutRequestId: string | null;
  stkAttempts: number;
  lastPushError: string | null;
  mpesaReceipt: string | null;
  resultCode: number | null;
  resultDesc: string | null;
  resolvedBy: 'callback' | 'query' | null;
  reconcileAttempts: number;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  failedAt: string | null;
}

export interface ChargeRow {
  id: string;
  sale_id: string;
  tenant_id: string;
  amount_minor: number;
  till: string;
  customer_msisdn: string;
  status: ChargeStatus;
  merchant_request_id: string | null;
  checkout_request_id: string | null;
  stk_attempts: number;
  last_push_error: string | null;
  mpesa_receipt: string | null;
  result_code: number | null;
  result_desc: string | null;
  resolved_by: 'callback' | 'query' | null;
  reconcile_attempts: number;
  last_reconciled_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  paid_at: string | Date | null;
  failed_at: string | Date | null;
}

export function rowToCharge(r: ChargeRow): Charge {
  return {
    id: r.id,
    saleId: r.sale_id,
    tenantId: r.tenant_id,
    amountMinor: r.amount_minor,
    till: r.till,
    customerMsisdn: r.customer_msisdn,
    status: r.status,
    merchantRequestId: r.merchant_request_id,
    checkoutRequestId: r.checkout_request_id,
    stkAttempts: r.stk_attempts,
    lastPushError: r.last_push_error,
    mpesaReceipt: r.mpesa_receipt,
    resultCode: r.result_code,
    resultDesc: r.result_desc,
    resolvedBy: r.resolved_by,
    reconcileAttempts: r.reconcile_attempts,
    lastReconciledAt: iso(r.last_reconciled_at),
    createdAt: iso(r.created_at) ?? '',
    updatedAt: iso(r.updated_at) ?? '',
    paidAt: iso(r.paid_at),
    failedAt: iso(r.failed_at),
  };
}

/** pg returns TIMESTAMPTZ as Date; pg-mem may return either. Normalise to ISO. */
export function iso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : v;
}

/** The public shape of a charge on the wire — what POS's client reads. */
export interface ChargeResponse {
  chargeId: string;
  saleId: string;
  status: ChargeStatus;
  amountMinor: number;
  checkoutRequestId: string | null;
  /** True when this call created the charge; false when it returned an existing one (I2). */
  created: boolean;
}
