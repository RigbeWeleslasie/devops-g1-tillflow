/**
 * In-process stand-ins for the two services Commission talks to. Same
 * pattern as services/pos/test/fakes/fakePaymentsClient.ts: the worker's
 * logic runs with no network at all, and a test can make either boundary
 * fail on demand.
 */
import { randomUUID } from 'node:crypto';
import type {
  DailyCloseSnapshot,
  DailyCloseTenant,
  PaymentsClient,
  PosReadClient,
  PayoutResponse,
  RequestPayoutResult,
} from '../src/types.js';
import { nairobiDayBounds } from '../src/services/businessDay.js';
import type { Db } from '../src/db.js';

export class FakePosClient implements PosReadClient {
  calls: string[] = [];
  failWith: Error | null = null;
  constructor(private readonly tenantsByDay: Record<string, DailyCloseTenant[]> = {}) {}

  setDay(businessDay: string, tenants: DailyCloseTenant[]): void {
    this.tenantsByDay[businessDay] = tenants;
  }

  async dailyClose(businessDay: string): Promise<DailyCloseSnapshot> {
    this.calls.push(businessDay);
    if (this.failWith) throw this.failWith;
    const { startUtc, endUtc } = nairobiDayBounds(businessDay);
    return {
      businessDay,
      windowUtc: { start: startUtc.toISOString(), end: endUtc.toISOString() },
      tenants: this.tenantsByDay[businessDay] ?? [],
    };
  }
}

/**
 * Mirrors the real Payments API, INCLUDING its side effects on the shared
 * schema. Two behaviours are load-bearing:
 *
 *   1. Idempotency on ledgerId — the first request creates a payout, later
 *      ones return the same one with created=false. So a test proving
 *      "duplicate disbursement = 0" counts `disbursements`, not calls.
 *   2. It flips payout_ledger.status COMPUTED -> REQUESTED, exactly as
 *      services/payments/src/services/payoutService.ts does. Payments owns
 *      that column (architecture.md §3), and Commission reads it back to
 *      decide what still needs requesting. A fake that skipped this made
 *      every replay look like it re-requested — the fake was lying, and the
 *      test caught it.
 *
 * It takes the Db for that reason: a fake at a service boundary has to
 * honour the contract's effects, not just its return shape.
 */
export class FakePaymentsClient implements PaymentsClient {
  readonly calls: string[] = [];
  /** One entry per ledgerId that actually caused money to move. */
  readonly disbursements = new Map<string, PayoutResponse>();
  /** Next N requests fail as 'unknown' (an HTTP/timeout failure, not a decline). */
  failNextAsUnknown = 0;
  /** Next N requests are rejected outright by Payments. */
  rejectNext = 0;

  constructor(private readonly db?: Db) {}

  async requestPayout(ledgerId: string): Promise<RequestPayoutResult> {
    this.calls.push(ledgerId);

    if (this.failNextAsUnknown > 0) {
      this.failNextAsUnknown--;
      return { outcome: 'unknown', reason: 'connection reset' };
    }
    if (this.rejectNext > 0) {
      this.rejectNext--;
      return { outcome: 'rejected', status: 400, error: 'nothing_to_pay' };
    }

    const existing = this.disbursements.get(ledgerId);
    if (existing) {
      return { outcome: 'accepted', payout: { ...existing, created: false } };
    }

    const row = await this.db?.query<{ payout_minor: number }>(
      'SELECT payout_minor FROM payout_ledger WHERE id = $1',
      [ledgerId],
    );
    // The transition Payments performs. Guarded the same way, so a repeat is
    // a no-op here too.
    await this.db?.query(
      `UPDATE payout_ledger SET status = 'REQUESTED' WHERE id = $1 AND status = 'COMPUTED'`,
      [ledgerId],
    );

    const payout: PayoutResponse = {
      payoutId: randomUUID(),
      ledgerId,
      status: 'PENDING',
      amountMinor: row?.rows[0]?.payout_minor ?? 0,
      conversationId: `AG_fake_${this.disbursements.size + 1}`,
      created: true,
    };
    this.disbursements.set(ledgerId, payout);
    return { outcome: 'accepted', payout };
  }
}

/** A tenant with one attendant and the given sale totals. */
export function tenantWith(opts: {
  tenantId?: string;
  attendantId?: string;
  msisdn?: string | null;
  rateBps?: number;
  saleTotals: number[];
}): DailyCloseTenant {
  return {
    tenantId: opts.tenantId ?? randomUUID(),
    attendants: [
      {
        attendantId: opts.attendantId ?? randomUUID(),
        msisdn: opts.msisdn === null ? null : (opts.msisdn ?? '254700000000'),
        rateBps: opts.rateBps ?? 500,
        sales: opts.saleTotals.map((totalMinor) => ({ saleId: randomUUID(), totalMinor })),
      },
    ],
  };
}
