/**
 * Daraja 3.0's JSON wire shapes, exactly as documented at
 * developer.safaricom.co.ke. Shared by DarajaAdapter (which sends/parses
 * them) and the stub-server (which parses/sends them), so the two cannot
 * drift apart — one type, both sides.
 *
 * Nothing here is our vocabulary; these are Safaricom's field names.
 */

// --- OAuth --------------------------------------------------------------

export interface OAuthResponse {
  access_token: string;
  /** Seconds, as a string ("3599"). */
  expires_in: string;
}

// --- STK Push -------------------------------------------------------------

export interface StkPushWireRequest {
  BusinessShortCode: string;
  /** base64(BusinessShortCode + Passkey + Timestamp) */
  Password: string;
  /** yyyyMMddHHmmss */
  Timestamp: string;
  TransactionType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
  /** Whole KES. Daraja does not accept cents. */
  Amount: number;
  PartyA: string;
  PartyB: string;
  PhoneNumber: string;
  CallBackURL: string;
  AccountReference: string;
  TransactionDesc: string;
}

export interface StkPushWireResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

export interface StkQueryWireRequest {
  BusinessShortCode: string;
  Password: string;
  Timestamp: string;
  CheckoutRequestID: string;
}

export interface StkQueryWireResponse {
  ResponseCode: string;
  ResponseDescription: string;
  MerchantRequestID: string;
  CheckoutRequestID: string;
  /** A string on the wire ("0", "1032"), despite being a number in callbacks. */
  ResultCode: string;
  ResultDesc: string;
}

// --- B2C ----------------------------------------------------------------

export interface B2CWireRequest {
  OriginatorConversationID: string;
  InitiatorName: string;
  SecurityCredential: string;
  CommandID: 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment';
  Amount: number;
  PartyA: string;
  PartyB: string;
  Remarks: string;
  QueueTimeOutURL: string;
  ResultURL: string;
  Occasion?: string;
}

export interface B2CWireResponse {
  ConversationID: string;
  OriginatorConversationID: string;
  ResponseCode: string;
  ResponseDescription: string;
}

// --- Errors -------------------------------------------------------------

/**
 * Daraja's error envelope. Non-2xx responses carry this. The one code that
 * is NOT an error for us: 500.001.1001 on a query means "still in flight".
 */
export interface DarajaErrorResponse {
  requestId: string;
  errorCode: string;
  errorMessage: string;
}

export const DARAJA_ERROR = {
  /** STK query on a push the customer hasn't acted on yet. Maps to StkQueryResult 'pending'. */
  TRANSACTION_IN_PROGRESS: '500.001.1001',
} as const;

export const DARAJA_PATH = {
  OAUTH: '/oauth/v1/generate',
  STK_PUSH: '/mpesa/stkpush/v1/processrequest',
  STK_QUERY: '/mpesa/stkpushquery/v1/query',
  B2C: '/mpesa/b2c/v3/paymentrequest',
} as const;

/** yyyyMMddHHmmss in East Africa Time (UTC+3, no DST), as Daraja expects. */
export function darajaTimestamp(ms: number): string {
  const d = new Date(ms + 3 * 60 * 60 * 1000);
  const p = (v: number): string => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** base64(shortcode + passkey + timestamp) — the STK "Password" field. */
export function stkPassword(shortCode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
}

/**
 * Minor units -> whole KES. Daraja bills whole shillings; a fractional
 * amount is refused here rather than rounded, so the platform never charges
 * a customer a cent more or less than the sale said.
 */
export function minorToKes(amountMinor: number): number {
  if (amountMinor % 100 !== 0) {
    throw new RangeError(
      `M-Pesa amounts must be whole shillings; ${amountMinor} minor units is not (KES ${amountMinor / 100})`,
    );
  }
  return amountMinor / 100;
}
