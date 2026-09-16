/**
 * The two boundaries the commission worker talks across, as interfaces.
 *
 * Neither is a database: the worker reads sales from the POS API and
 * requests money from the Payments API. It holds no Daraja credentials and
 * its task role cannot read the daraja secret (infra/data.tf), so
 * "commission never calls Daraja directly" is enforced by IAM, not just by
 * this file's shape. Both are interfaces so tests run with no network.
 */

// --- What POS gives us (services/pos/src/routes/internal.ts) --------------

export interface DailyCloseSale {
  saleId: string;
  totalMinor: number;
}

export interface DailyCloseAttendant {
  attendantId: string;
  /** null when the attendant has no payout destination: unpayable, but still ledgered. */
  msisdn: string | null;
  rateBps: number;
  /** Individual sale amounts. Per-sale, because the rounding rule is per-sale. */
  sales: DailyCloseSale[];
}

export interface DailyCloseTenant {
  tenantId: string;
  attendants: DailyCloseAttendant[];
}

export interface DailyCloseSnapshot {
  businessDay: string;
  windowUtc: { start: string; end: string };
  tenants: DailyCloseTenant[];
}

export interface PosReadClient {
  dailyClose(businessDay: string): Promise<DailyCloseSnapshot>;
}

// --- What Payments gives us (services/payments/src/routes/payouts.ts) -----

export type PayoutStatus = 'PENDING' | 'PAID' | 'FAILED';

export interface PayoutResponse {
  payoutId: string;
  ledgerId: string;
  status: PayoutStatus;
  amountMinor: number;
  conversationId: string | null;
  created: boolean;
}

/**
 * `outcome: 'unknown'` mirrors the POS -> Payments client: an HTTP failure
 * is not a payout failure. Payments owns that state machine, and POST
 * /payouts is idempotent on ledgerId, so retrying later is always safe —
 * inventing a FAILED here would be the worker guessing about money.
 */
export type RequestPayoutResult =
  | { outcome: 'accepted'; payout: PayoutResponse }
  | { outcome: 'rejected'; status: number; error: string }
  | { outcome: 'unknown'; reason: string };

export interface PaymentsClient {
  requestPayout(ledgerId: string): Promise<RequestPayoutResult>;
}
