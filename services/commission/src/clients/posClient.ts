/**
 * HTTP client for POS's internal daily-close read API
 * (services/pos/src/routes/internal.ts).
 *
 * This one throws on failure rather than returning an `unknown` outcome,
 * and that asymmetry with the Payments client is deliberate: if we cannot
 * read the sales, there is nothing to compute and the close must fail
 * loudly so it can be re-run. Guessing at a day's sales would produce a
 * wrong ledger row, and the ledger's unique constraint would then make
 * that wrong row permanent.
 */
import type { DailyCloseSnapshot, PosReadClient } from '../types.js';

export interface HttpPosClientOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class PosUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PosUnavailableError';
  }
}

export class HttpPosClient implements PosReadClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpPosClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.serviceToken = opts.serviceToken;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async dailyClose(businessDay: string): Promise<DailyCloseSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/internal/daily-close?businessDay=${encodeURIComponent(businessDay)}`,
        {
          method: 'GET',
          headers: { 'x-service-token': this.serviceToken, accept: 'application/json' },
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        throw new PosUnavailableError(
          `POS /internal/daily-close returned HTTP ${res.status} for ${businessDay}`,
        );
      }
      const body = (await res.json()) as DailyCloseSnapshot;
      if (body.businessDay !== businessDay || !Array.isArray(body.tenants)) {
        throw new PosUnavailableError(
          `POS returned a snapshot for "${body.businessDay}" when asked for "${businessDay}"`,
        );
      }
      return body;
    } catch (err) {
      if (err instanceof PosUnavailableError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new PosUnavailableError(`POS did not answer within ${this.timeoutMs}ms`);
      }
      throw new PosUnavailableError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}
