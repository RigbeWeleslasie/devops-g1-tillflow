/**
 * Wire-level types for the M-Pesa (Daraja 3.0) integration.
 *
 * Two naming conventions coexist here on purpose:
 *   - Requests/acks we build are camelCase and carry `amountMinor` (integer
 *     KES cents, see @tillflow/shared/money) — the shape our own code speaks.
 *   - Callback bodies are Daraja's own PascalCase wire shape, untouched. The
 *     Payments service must parse exactly what Daraja POSTs, and the fake must
 *     produce exactly that, so nothing is renamed in between.
 *
 * Daraja itself bills whole shillings. DarajaAdapter converts minor units to
 * KES and REJECTS a fractional-shilling amount rather than rounding either way
 * — the platform never silently over- or under-charges a customer by a cent.
 */
import type { MinorUnits } from '@tillflow/shared/money';

/** E.164 without the leading '+', as Daraja expects: 2547XXXXXXXX. */
export type Msisdn = string;

// ---------------------------------------------------------------------------
// STK Push (Lipa na M-Pesa Online) — customer-initiated payment prompt
// ---------------------------------------------------------------------------

export interface StkPushRequest {
  amountMinor: MinorUnits;
  phoneNumber: Msisdn;
  /** Till / business shortcode the money lands in. */
  shortCode: string;
  /** Shown to the customer; Daraja caps this at 12 characters. */
  accountReference: string;
  transactionDesc: string;
  callbackUrl: string;
  /**
   * Ignored by DarajaAdapter. FakeAdapter reads it as a scenario override
   * (populated from the `X-Fake-Scenario` request header, ADR 0005) so a drill
   * can force e.g. a timeout without contriving an amount ending in `03`.
   */
  scenarioHint?: string;
}

export interface StkPushAck {
  merchantRequestId: string;
  /** The id every later callback and query is keyed on. */
  checkoutRequestId: string;
  /** '0' = accepted for processing. Anything else is a synchronous rejection. */
  responseCode: string;
  responseDescription: string;
  customerMessage: string;
}

/**
 * Daraja answers a query on an in-flight push with an error envelope
 * (500.001.1001 "The transaction is being processed") rather than a result.
 * That is modelled as `pending`, not as an error: it is the normal state of a
 * charge the customer has not acted on yet, and the reconciler must treat it
 * as "ask again later", never as a decline (I5).
 */
export type StkQueryResult =
  | { status: 'pending' }
  | { status: 'complete'; resultCode: number; resultDesc: string };

/** ResultCode values the Payments service maps to charge states. */
export const STK_RESULT = {
  SUCCESS: 0,
  INSUFFICIENT_FUNDS: 1,
  CANCELLED_BY_USER: 1032,
  /** The customer never responded to the prompt. A terminal decline from Daraja's side. */
  USER_TIMEOUT: 1037,
} as const;

/**
 * What Daraja POSTs to `callbackUrl` after the customer acts. CallbackMetadata
 * is present only on success and carries Amount (in KES, e.g. 1 or 1.5),
 * MpesaReceiptNumber, TransactionDate (yyyyMMddHHmmss) and PhoneNumber.
 */
export interface StkCallbackBody {
  Body: {
    stkCallback: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: {
        Item: Array<{ Name: string; Value?: string | number }>;
      };
    };
  };
}

// ---------------------------------------------------------------------------
// B2C — business-initiated payout to a customer's phone
// ---------------------------------------------------------------------------

export interface B2CRequest {
  amountMinor: MinorUnits;
  phoneNumber: Msisdn;
  /**
   * Our own idempotency reference — the payout ledger id. Daraja echoes it
   * back as OriginatorConversationID on the result, which is how a result
   * callback finds its payout row.
   */
  originatorConversationId: string;
  remarks: string;
  occasion?: string;
  resultUrl: string;
  timeoutUrl: string;
  /** See StkPushRequest.scenarioHint. */
  scenarioHint?: string;
}

export interface B2CAck {
  conversationId: string;
  originatorConversationId: string;
  responseCode: string;
  responseDescription: string;
}

export const B2C_RESULT = {
  SUCCESS: 0,
  INSUFFICIENT_BALANCE: 1,
  INVALID_RECEIVER: 2001,
} as const;

/** What Daraja POSTs to `resultUrl` when a B2C request reaches a terminal state. */
export interface B2CResultBody {
  Result: {
    ResultType: number;
    ResultCode: number;
    ResultDesc: string;
    OriginatorConversationID: string;
    ConversationID: string;
    TransactionID: string;
    ResultParameters?: {
      ResultParameter: Array<{ Key: string; Value?: string | number }>;
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers for reading Daraja's Item/Key lists
// ---------------------------------------------------------------------------

/** Pulls a named value out of Daraja's `[{Name, Value}]` metadata list. */
export function metadataItem(
  body: StkCallbackBody,
  name: string,
): string | number | undefined {
  const items = body.Body.stkCallback.CallbackMetadata?.Item ?? [];
  return items.find((i) => i.Name === name)?.Value;
}

/** Same for B2C's `[{Key, Value}]` result parameter list. */
export function resultParameter(
  body: B2CResultBody,
  key: string,
): string | number | undefined {
  const params = body.Result.ResultParameters?.ResultParameter ?? [];
  return params.find((p) => p.Key === key)?.Value;
}
