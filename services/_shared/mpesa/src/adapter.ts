/**
 * The one interface the Payments service programs against (ADR 0005).
 *
 * Two implementations: DarajaAdapter (real HTTP to the sandbox, prod only)
 * and FakeAdapter (in-process, deterministic, every test/CI/k6 run).
 * `MPESA_ADAPTER=daraja|fake` picks one at startup; nothing downstream knows
 * which it got.
 *
 * Callbacks are NOT adapter methods. Daraja delivers them by POSTing to the
 * Payments service's own HTTP endpoints; the fake does the same (see
 * FakeAdapter.deliverPending), so the whole callback code path — dedupe,
 * guarded transition, outbox row, trace — runs identically under both.
 *
 * OAuth token handling is DarajaAdapter's internal concern, not part of the
 * interface: the fake has nothing to authenticate against, and the Payments
 * service has no reason to ever see a token.
 */
import type {
  StkPushRequest,
  StkPushAck,
  StkQueryResult,
  B2CRequest,
  B2CAck,
} from './types.js';

export interface MpesaAdapter {
  stkPush(req: StkPushRequest): Promise<StkPushAck>;
  stkQuery(checkoutRequestId: string): Promise<StkQueryResult>;
  b2cPayment(req: B2CRequest): Promise<B2CAck>;
}

// ---------------------------------------------------------------------------
// Errors. The distinction that matters most is timeout vs everything else:
// a timeout means the provider's state is UNKNOWN — the push may or may not
// have gone through — and the Payments service must leave the charge PENDING
// (I5). A rejection is a definite answer and can be acted on.
// ---------------------------------------------------------------------------

export class MpesaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MpesaError';
  }
}

/**
 * No acknowledgement within the HTTP timeout. "A timeout is not a decline":
 * callers must NOT map this to FAILED. The request may have reached Daraja;
 * a callback may still arrive.
 */
export class MpesaTimeoutError extends MpesaError {
  constructor(message = 'no acknowledgement from M-Pesa within the timeout') {
    super(message);
    this.name = 'MpesaTimeoutError';
  }
}

/** Network-level failure before any response (DNS, connection refused, reset). Provider state also unknown. */
export class MpesaTransportError extends MpesaError {
  constructor(message: string) {
    super(message);
    this.name = 'MpesaTransportError';
  }
}

/** OAuth failed. Configuration problem, never a per-charge outcome. */
export class MpesaAuthError extends MpesaError {
  constructor(message: string) {
    super(message);
    this.name = 'MpesaAuthError';
  }
}

/**
 * Daraja answered synchronously with a non-accept (bad shortcode, malformed
 * request, invalid amount). A definite answer: nothing was initiated.
 */
export class MpesaRejectedError extends MpesaError {
  readonly responseCode: string;
  constructor(responseCode: string, message: string) {
    super(message);
    this.name = 'MpesaRejectedError';
    this.responseCode = responseCode;
  }
}

/** True for errors where the provider's state is unknown and the charge must stay PENDING. */
export function isUncertainOutcome(err: unknown): boolean {
  return err instanceof MpesaTimeoutError || err instanceof MpesaTransportError;
}
