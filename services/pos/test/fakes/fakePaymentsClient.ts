import { randomUUID } from 'node:crypto';
import type { CreateChargeRequest, CreateChargeResult, PaymentsClient } from '../../src/services/paymentsClient.js';

/**
 * In-process stand-in for the real Payments service, matching only the one
 * contract POS depends on. `mode` lets a test choose the scenario:
 *   - 'accept' (default): always returns a fresh chargeId.
 *   - 'unknown': simulates the HTTP call to Payments itself timing out.
 */
export class FakePaymentsClient implements PaymentsClient {
  public readonly calls: CreateChargeRequest[] = [];
  constructor(private readonly mode: 'accept' | 'unknown' = 'accept') {}

  async createCharge(req: CreateChargeRequest): Promise<CreateChargeResult> {
    this.calls.push(req);
    if (this.mode === 'unknown') {
      return { outcome: 'unknown' };
    }
    return { outcome: 'accepted', chargeId: randomUUID(), status: 'PENDING' };
  }
}
