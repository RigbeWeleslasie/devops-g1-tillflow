/**
 * The daily close: I4 — one payout per (tenant, attendant, business day),
 * and duplicate disbursement = 0.
 *
 * Replay safety comes from three things, in this order:
 *
 *   1. The ledger row is written with INSERT ... ON CONFLICT DO NOTHING on
 *      UNIQUE(tenant_id, attendant_id, business_day). A re-run finds the row
 *      already there and inserts nothing. This is the invariant; everything
 *      else is bookkeeping.
 *   2. The B2C request is made through the Payments API, which is itself
 *      idempotent on ledgerId. So even a row that was computed but whose
 *      payout request was lost mid-flight converges on exactly one payment.
 *   3. Requesting the payout is a SEPARATE step from computing the row, and
 *      a re-run re-requests only rows still in COMPUTED. A crash between the
 *      two leaves a COMPUTED row that the next run picks up — at-least-once
 *      request, exactly-once payment.
 *
 * Rate and MSISDN are SNAPSHOT into the ledger row at compute time
 * (threat-model.md A5/A7): a later rate edit or phone-number change cannot
 * alter a payout that was already computed.
 *
 * Money: commission is `floor(total * rate_bps / 10000)` PER SALE, summed —
 * the single rounding rule in @tillflow/shared/money. B2C pays whole
 * shillings, so the ledger also records payout_minor (floored to a shilling)
 * and remainder_minor (the cents that stay with the tenant), making the
 * truncation auditable rather than silent.
 */
import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { commissionForSale, sumMinor, toMinorUnits, type MinorUnits } from '@tillflow/shared/money';
import type { Db } from '../db.js';
import { didInsert } from '../db.js';
import type { DailyCloseAttendant, PaymentsClient, PosReadClient } from '../types.js';
import { isBusinessDay } from './businessDay.js';

export interface CloseOptions {
  db: Db;
  pos: PosReadClient;
  payments: PaymentsClient;
  now?: () => Date;
  logger?: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

export interface CloseResult {
  runId: string;
  businessDay: string;
  tenantsProcessed: number;
  attendantsProcessed: number;
  ledgerRowsCreated: number;
  ledgerRowsExisting: number;
  payoutsRequested: number;
  payoutsSkippedZero: number;
  payoutsUncertain: number;
  status: 'COMPLETED' | 'FAILED';
  error?: string;
}

export class InvalidBusinessDayError extends Error {}

/** What one attendant's day comes to. Pure — no I/O, so it is trivially testable. */
export interface ComputedCommission {
  saleCount: number;
  saleTotalMinor: MinorUnits;
  /** Exact commission: per-sale floor, then summed. */
  amountMinor: MinorUnits;
  /** What B2C can actually send: amountMinor floored to whole shillings. */
  payoutMinor: MinorUnits;
  /** The cents that cannot be sent. Recorded so the truncation is visible. */
  remainderMinor: number;
}

export function computeCommission(attendant: DailyCloseAttendant): ComputedCommission {
  const totals = attendant.sales.map((s) => toMinorUnits(s.totalMinor));
  const perSale = totals.map((t) => commissionForSale(t, attendant.rateBps));
  const amountMinor = sumMinor(perSale);
  const payoutMinor = toMinorUnits(Math.floor(amountMinor / 100) * 100);
  return {
    saleCount: attendant.sales.length,
    saleTotalMinor: sumMinor(totals),
    amountMinor,
    payoutMinor,
    remainderMinor: amountMinor - payoutMinor,
  };
}

export async function runClose(businessDay: string, opts: CloseOptions): Promise<CloseResult> {
  if (!isBusinessDay(businessDay)) {
    throw new InvalidBusinessDayError(`businessDay must be a real YYYY-MM-DD date, got "${businessDay}"`);
  }
  const now = opts.now ?? (() => new Date());
  const { db, logger } = opts;
  const runId = randomUUID();
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'commission.business_day': businessDay, 'commission.run_id': runId });

  const result: CloseResult = {
    runId,
    businessDay,
    tenantsProcessed: 0,
    attendantsProcessed: 0,
    ledgerRowsCreated: 0,
    ledgerRowsExisting: 0,
    payoutsRequested: 0,
    payoutsSkippedZero: 0,
    payoutsUncertain: 0,
    status: 'COMPLETED',
  };

  await db.query(
    `INSERT INTO close_runs (id, business_day, trigger_source, status, started_at) VALUES ($1, $2, $3, 'RUNNING', $4)`,
    [runId, businessDay, 'worker', now().toISOString()],
  );

  try {
    const snapshot = await opts.pos.dailyClose(businessDay);

    for (const tenant of snapshot.tenants) {
      result.tenantsProcessed++;
      for (const attendant of tenant.attendants) {
        result.attendantsProcessed++;
        const computed = computeCommission(attendant);

        const ledgerId = randomUUID();
        const ts = now().toISOString();
        // SKIPPED rather than omitted, for two different reasons:
        //   - nothing to send (earned nothing, or under one shilling), or
        //   - nowhere to send it (no MSISDN on the attendant record).
        // Either way the attendant appears in the day's ledger with their
        // real commission recorded, so an owner can see WHY nobody was paid.
        // Omitting them would make paid sales vanish from the close.
        const payable = computed.payoutMinor > 0 && attendant.msisdn !== null;
        const status = payable ? 'COMPUTED' : 'SKIPPED';
        if (computed.payoutMinor > 0 && attendant.msisdn === null) {
          logger?.warn(
            { tenantId: tenant.tenantId, attendantId: attendant.attendantId, amountMinor: computed.amountMinor },
            'close: attendant earned commission but has no MSISDN — ledgered as SKIPPED, nothing sent',
          );
        }

        const inserted = await db.query<{ id: string }>(
          `INSERT INTO payout_ledger
             (id, tenant_id, attendant_id, business_day, amount_minor, payout_minor, remainder_minor,
              rate_bps, msisdn, sale_count, sale_total_minor, status, close_run_id, computed_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
           ON CONFLICT (tenant_id, attendant_id, business_day) DO NOTHING
           RETURNING id`,
          [
            ledgerId,
            tenant.tenantId,
            attendant.attendantId,
            businessDay,
            computed.amountMinor,
            computed.payoutMinor,
            computed.remainderMinor,
            attendant.rateBps,
            attendant.msisdn ?? '',
            computed.saleCount,
            computed.saleTotalMinor,
            status,
            runId,
            ts,
          ],
        );

        // didInsert, never rowCount: pg-mem returns the EXISTING row on a
        // conflict where Postgres returns none (services/commission/src/db.ts).
        const created = didInsert(inserted, ledgerId);
        if (created) {
          result.ledgerRowsCreated++;
        } else {
          result.ledgerRowsExisting++;
          logger?.info(
            { tenantId: tenant.tenantId, attendantId: attendant.attendantId, businessDay },
            'close: ledger row already exists — replay, nothing recomputed',
          );
        }

        if (status === 'SKIPPED') {
          result.payoutsSkippedZero++;
          continue;
        }

        // Request the payout for any row still COMPUTED — whether we just
        // created it or a previous run did and then crashed. Payments is
        // idempotent on ledgerId, so this is safe to repeat.
        const existing = await db.query<{ id: string; status: string }>(
          `SELECT id, status FROM payout_ledger WHERE tenant_id = $1 AND attendant_id = $2 AND business_day = $3`,
          [tenant.tenantId, attendant.attendantId, businessDay],
        );
        const row = existing.rows[0];
        if (!row || row.status !== 'COMPUTED') continue;

        const payout = await opts.payments.requestPayout(row.id);
        if (payout.outcome === 'accepted') {
          result.payoutsRequested++;
          span?.setAttributes({ 'payout.ledger_id': row.id });
          logger?.info(
            {
              'payout.ledger_id': row.id,
              'payments.payout_id': payout.payout.payoutId,
              tenantId: tenant.tenantId,
              attendantId: attendant.attendantId,
              amountMinor: computed.payoutMinor,
              alreadyExisted: !payout.payout.created,
            },
            'close: payout requested',
          );
        } else if (payout.outcome === 'unknown') {
          // The HTTP call failed. Payments may or may not have the request.
          // Leave the row COMPUTED — the next run re-requests it, and
          // idempotency-on-ledgerId makes that safe. Never mark it FAILED.
          result.payoutsUncertain++;
          logger?.warn(
            { 'payout.ledger_id': row.id, reason: payout.reason },
            'close: payout request outcome unknown; row stays COMPUTED for the next run',
          );
        } else {
          result.payoutsUncertain++;
          logger?.error(
            { 'payout.ledger_id': row.id, status: payout.status, error: payout.error },
            'close: payout rejected by Payments',
          );
        }
      }
    }
  } catch (err) {
    result.status = 'FAILED';
    result.error = err instanceof Error ? err.message : String(err);
    await finishRun(db, runId, result, now());
    throw err;
  }

  await finishRun(db, runId, result, now());
  logger?.info({ ...result }, 'close: complete');
  return result;
}

async function finishRun(db: Db, runId: string, r: CloseResult, now: Date): Promise<void> {
  await db.query(
    `UPDATE close_runs
     SET status = $2, tenants_processed = $3, ledger_rows_created = $4, ledger_rows_existing = $5,
         payouts_requested = $6, error = $7, finished_at = $8
     WHERE id = $1`,
    [
      runId,
      r.status,
      r.tenantsProcessed,
      r.ledgerRowsCreated,
      r.ledgerRowsExisting,
      r.payoutsRequested,
      r.error ?? null,
      now.toISOString(),
    ],
  );
}
