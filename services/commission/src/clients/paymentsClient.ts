/**
 * HTTP client for POST /payouts — the ONLY way this worker moves money.
 * It holds no Daraja credentials and its task role cannot read the daraja
 * secret (infra/data.tf), so the architecture's hard rule is enforced below
 * this code, not by it.
 *
 * The outcome vocabulary mirrors services/pos/src/services/paymentsClient.ts:
 * a transport failure or a 5xx is `unknown`, NOT a failure. Payments owns
 * the payout state machine, and POST /payouts is idempotent on ledgerId, so
 * leaving the ledger row COMPUTED and re-requesting next run is always safe.
 * Reporting `rejected` for a timeout would let the worker invent a failure
 * Payments never declared — and a payout wrongly abandoned is an attendant
 * who does not get paid.
 */
import type { PaymentsClient, PayoutResponse, RequestPayoutResult } from '../types.js';

export interface HttpPaymentsClientOptions {
  baseUrl: string;
  serviceToken: string;
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
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async requestPayout(ledgerId: string): Promise<RequestPayoutResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/payouts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': this.serviceToken,
        },
        body: JSON.stringify({ ledgerId }),
        signal: controller.signal,
      });

      // 201 created, 200 already existed — both mean Payments has it.
      if (res.ok) {
        const payout = (await res.json()) as PayoutResponse;
        return { outcome: 'accepted', payout };
      }

      // 5xx: Payments may have accepted the payout before failing. Unknown.
      if (res.status >= 500) {
        return { outcome: 'unknown', reason: `Payments returned HTTP ${res.status}` };
      }

      // 4xx: a definite refusal (unknown ledger, zero payout, bad token).
      // Nothing was initiated, and re-requesting will not help — a human
      // needs to look at it.
      const body = (await res.text().catch(() => '')) || '(no body)';
      return { outcome: 'rejected', status: res.status, error: body.slice(0, 500) };
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `Payments did not answer within ${this.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      return { outcome: 'unknown', reason };
    } finally {
      clearTimeout(timer);
    }
  }
}
