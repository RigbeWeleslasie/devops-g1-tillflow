/**
 * Client for the one contract POS depends on from Payments:
 *   POST /charges { saleId, tenantId, amountMinor, tenantTill, customerMsisdn }
 *     -> idempotent on saleId.
 *   A timeout leaves the charge PENDING -- never FAILED.
 *
 * That "never FAILED on timeout" rule is enforced HERE, not just on the
 * Payments side: if the HTTP call to Payments itself times out or the
 * connection drops, this client returns `{ outcome: 'unknown' }` rather than
 * throwing a hard error that a caller might mistake for a declined payment.
 * Since POST /charges is idempotent on saleId, retrying (or letting the sale
 * sit with no chargeId yet) is always safe.
 */

export interface CreateChargeRequest {
  saleId: string;
  tenantId: string;
  amountMinor: number;
  tenantTill: string;
  /** Customer's phone for the STK Push. Kenyan MSISDN: 2547XXXXXXXX | 2541XXXXXXXX. */
  customerMsisdn: string;
}

export type CreateChargeResult =
  | { outcome: 'accepted'; chargeId: string; status: 'PENDING' }
  | { outcome: 'unknown' }; // the HTTP call itself failed/timed out; Payments' own state is unknown, not FAILED

export interface PaymentsClient {
  createCharge(req: CreateChargeRequest): Promise<CreateChargeResult>;
}

export interface HttpPaymentsClientOptions {
  baseUrl: string;
  /** Shared service token; Payments rejects /charges without it. */
  serviceToken: string;
  /** Milliseconds before the call is treated as `unknown`, not failed. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpPaymentsClient implements PaymentsClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpPaymentsClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.serviceToken = opts.serviceToken;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async createCharge(req: CreateChargeRequest): Promise<CreateChargeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/charges`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': this.serviceToken,
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) {
        // A 4xx/5xx from Payments is a definite answer, not a timeout -- but
        // it's still not "the charge failed" (Payments owns that state
        // machine); treat it the same as unknown so POS never invents a
        // FAILED status Payments didn't actually report.
        return { outcome: 'unknown' };
      }
      const body = (await res.json()) as { chargeId: string; status: 'PENDING' };
      return { outcome: 'accepted', chargeId: body.chargeId, status: 'PENDING' };
    } catch {
      // Network error, timeout (AbortController), or a malformed response.
      return { outcome: 'unknown' };
    } finally {
      clearTimeout(timer);
    }
  }
}
