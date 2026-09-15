/**
 * DarajaAdapter — real HTTPS to the Daraja 3.0 API (sandbox for this
 * capstone; ADR 0005). Prod runtime only, plus the one `@contract` test.
 *
 * Rules this class enforces so the Payments service doesn't have to:
 *   - A timeout or connection failure is MpesaTimeoutError /
 *     MpesaTransportError — provider state UNKNOWN. Never mapped to a
 *     decline (I5). Anything with a definite non-accept from Daraja is
 *     MpesaRejectedError.
 *   - The OAuth token is cached until shortly before expiry and refreshed
 *     once on a 401. It never leaves this class.
 *   - Credentials are read once at construction and never logged. This class
 *     does not log at all; it returns typed errors.
 *   - Amounts are converted from minor units to whole KES and REFUSED if
 *     fractional, never rounded.
 *
 * `fetchImpl` and `clock` are injectable so the round-trip test can point
 * this at the stub-server on an ephemeral port with a fixed clock.
 */
import type { MpesaAdapter } from './adapter.js';
import {
  MpesaAuthError,
  MpesaError,
  MpesaRejectedError,
  MpesaTimeoutError,
  MpesaTransportError,
} from './adapter.js';
import type {
  B2CAck,
  B2CRequest,
  StkPushAck,
  StkPushRequest,
  StkQueryResult,
} from './types.js';
import {
  DARAJA_ERROR,
  DARAJA_PATH,
  darajaTimestamp,
  minorToKes,
  stkPassword,
  type B2CWireRequest,
  type B2CWireResponse,
  type DarajaErrorResponse,
  type OAuthResponse,
  type StkPushWireRequest,
  type StkPushWireResponse,
  type StkQueryWireRequest,
  type StkQueryWireResponse,
} from './wire.js';

export interface DarajaCredentials {
  consumerKey: string;
  consumerSecret: string;
  /** Lipa na M-Pesa Online passkey for `stkShortCode`. */
  passkey: string;
  /** The BusinessShortCode STK pushes are made under (sandbox: 174379). */
  stkShortCode: string;
  b2c: {
    shortCode: string;
    initiatorName: string;
    /** RSA-encrypted initiator password, base64. Produced out-of-band per Daraja docs. */
    securityCredential: string;
  };
}

export interface DarajaAdapterOptions {
  baseUrl: string;
  credentials: DarajaCredentials;
  /** Per-request HTTP timeout. Past this, the outcome is UNKNOWN. */
  timeoutMs?: number;
  /** PayBill (sandbox default) or BuyGoods (a real till). */
  transactionType?: StkPushWireRequest['TransactionType'];
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

/** Refresh this long before Daraja says the token dies, so a request never straddles expiry. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

export class DarajaAdapter implements MpesaAdapter {
  private readonly baseUrl: string;
  private readonly creds: DarajaCredentials;
  private readonly timeoutMs: number;
  private readonly transactionType: StkPushWireRequest['TransactionType'];
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private token: CachedToken | undefined;

  constructor(opts: DarajaAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.creds = opts.credentials;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.transactionType = opts.transactionType ?? 'CustomerPayBillOnline';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clock = opts.clock ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // MpesaAdapter
  // -------------------------------------------------------------------------

  async stkPush(req: StkPushRequest): Promise<StkPushAck> {
    const timestamp = darajaTimestamp(this.clock());
    const body: StkPushWireRequest = {
      BusinessShortCode: this.creds.stkShortCode,
      Password: stkPassword(this.creds.stkShortCode, this.creds.passkey, timestamp),
      Timestamp: timestamp,
      TransactionType: this.transactionType,
      Amount: minorToKes(req.amountMinor),
      PartyA: req.phoneNumber,
      PartyB: req.shortCode,
      PhoneNumber: req.phoneNumber,
      CallBackURL: req.callbackUrl,
      AccountReference: req.accountReference.slice(0, 12),
      TransactionDesc: req.transactionDesc.slice(0, 13),
    };

    const res = await this.post<StkPushWireResponse>(DARAJA_PATH.STK_PUSH, body, req.scenarioHint);
    if (res.ResponseCode !== '0') {
      throw new MpesaRejectedError(res.ResponseCode, res.ResponseDescription);
    }
    return {
      merchantRequestId: res.MerchantRequestID,
      checkoutRequestId: res.CheckoutRequestID,
      responseCode: res.ResponseCode,
      responseDescription: res.ResponseDescription,
      customerMessage: res.CustomerMessage,
    };
  }

  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    const timestamp = darajaTimestamp(this.clock());
    const body: StkQueryWireRequest = {
      BusinessShortCode: this.creds.stkShortCode,
      Password: stkPassword(this.creds.stkShortCode, this.creds.passkey, timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    };

    try {
      const res = await this.post<StkQueryWireResponse>(DARAJA_PATH.STK_QUERY, body);
      return {
        status: 'complete',
        resultCode: Number(res.ResultCode),
        resultDesc: res.ResultDesc,
      };
    } catch (err) {
      // "The transaction is being processed" arrives as an HTTP 500 error
      // envelope. It is the normal in-flight state, not a failure.
      if (err instanceof MpesaRejectedError && err.responseCode === DARAJA_ERROR.TRANSACTION_IN_PROGRESS) {
        return { status: 'pending' };
      }
      throw err;
    }
  }

  async b2cPayment(req: B2CRequest): Promise<B2CAck> {
    const body: B2CWireRequest = {
      OriginatorConversationID: req.originatorConversationId,
      InitiatorName: this.creds.b2c.initiatorName,
      SecurityCredential: this.creds.b2c.securityCredential,
      CommandID: 'BusinessPayment',
      Amount: minorToKes(req.amountMinor),
      PartyA: this.creds.b2c.shortCode,
      PartyB: req.phoneNumber,
      Remarks: req.remarks.slice(0, 100),
      QueueTimeOutURL: req.timeoutUrl,
      ResultURL: req.resultUrl,
      ...(req.occasion !== undefined ? { Occasion: req.occasion.slice(0, 100) } : {}),
    };

    const res = await this.post<B2CWireResponse>(DARAJA_PATH.B2C, body, req.scenarioHint);
    if (res.ResponseCode !== '0') {
      throw new MpesaRejectedError(res.ResponseCode, res.ResponseDescription);
    }
    return {
      conversationId: res.ConversationID,
      originatorConversationId: res.OriginatorConversationID,
      responseCode: res.ResponseCode,
      responseDescription: res.ResponseDescription,
    };
  }

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  private async accessToken(force = false): Promise<string> {
    const now = this.clock();
    if (!force && this.token && now < this.token.expiresAtMs - TOKEN_SAFETY_MARGIN_MS) {
      return this.token.value;
    }

    const basic = Buffer.from(`${this.creds.consumerKey}:${this.creds.consumerSecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${this.baseUrl}${DARAJA_PATH.OAUTH}?grant_type=client_credentials`, {
        method: 'GET',
        headers: { authorization: `Basic ${basic}` },
      });
    } catch (err) {
      throw this.asTransportError(err);
    }

    if (!res.ok) {
      throw new MpesaAuthError(`Daraja OAuth failed with HTTP ${res.status}`);
    }
    const json = (await res.json()) as OAuthResponse;
    if (!json.access_token) {
      throw new MpesaAuthError('Daraja OAuth response had no access_token');
    }
    const ttlMs = Number(json.expires_in) * 1000;
    this.token = { value: json.access_token, expiresAtMs: now + (Number.isFinite(ttlMs) ? ttlMs : 3_599_000) };
    return this.token.value;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async post<T>(path: string, body: unknown, scenarioHint?: string): Promise<T> {
    let token = await this.accessToken();
    let res = await this.send(path, body, token, scenarioHint);

    if (res.status === 401) {
      // One refresh, then give up: a second 401 is a credentials problem.
      token = await this.accessToken(true);
      res = await this.send(path, body, token, scenarioHint);
      if (res.status === 401) {
        throw new MpesaAuthError('Daraja rejected the access token twice');
      }
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new MpesaError(`Daraja returned non-JSON (HTTP ${res.status})`);
    }

    if (!res.ok) {
      const errBody = json as Partial<DarajaErrorResponse>;
      const code = errBody.errorCode ?? String(res.status);
      const message = errBody.errorMessage ?? `Daraja returned HTTP ${res.status}`;
      // "Being processed" rides on an HTTP 500 but is a definite, expected
      // answer — stkQuery maps it to `pending`.
      if (code === DARAJA_ERROR.TRANSACTION_IN_PROGRESS) {
        throw new MpesaRejectedError(code, message);
      }
      // Any other 5xx: Daraja is unwell, and we cannot know whether it
      // processed the request before failing. Unknown state, never a decline.
      if (res.status >= 500) {
        throw new MpesaTransportError(`Daraja HTTP ${res.status}: ${message}`);
      }
      // 4xx: a definite non-accept. Nothing was initiated.
      throw new MpesaRejectedError(code, message);
    }
    return json as T;
  }

  private async send(path: string, body: unknown, token: string, scenarioHint?: string): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    // Forwarded so the stub-server (a fake Daraja) can honour a drill's
    // scenario override. The real sandbox ignores unknown headers.
    if (scenarioHint) headers['x-fake-scenario'] = scenarioHint;

    try {
      return await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw this.asTransportError(err);
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private asTransportError(err: unknown): MpesaError {
    if (err instanceof MpesaError) return err;
    if (err instanceof Error && err.name === 'AbortError') {
      return new MpesaTimeoutError(`no response from Daraja within ${this.timeoutMs}ms`);
    }
    return new MpesaTransportError(err instanceof Error ? err.message : String(err));
  }
}
