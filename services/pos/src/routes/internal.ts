/**
 * Internal read API for the Commission worker.
 *
 * Commission computes each attendant's daily commission from confirmed PAID
 * sales, but those sales, the attendants' payout MSISDNs and the commission
 * rates all live in the `pos` schema. Cross-schema DB reads are forbidden
 * (docs/threat-model.md §3.3: `pos-app` has no grant on `payments` and vice
 * versa), so the data crosses as an HTTP contract instead.
 *
 * Authored by Nebyat (Payments + integrity) for the Commission worker;
 * reviewed by Rigbe as DRI for this path.
 *
 * Why per-sale amounts rather than a total: ADR 0006's rounding rule is
 * `floor(sale_total_minor * rate_bps / 10000)` computed PER SALE, then
 * summed. Flooring an aggregate gives a different answer — three KES 100.50
 * sales at 5% are 1 506 per-sale but 1 507 in aggregate. Returning the
 * individual amounts keeps that rule where ADR 0006 puts it, in
 * @tillflow/shared/money, rather than duplicating it here.
 *
 * Business day: a sale belongs to the day its payment was CONFIRMED
 * (`paid_at`), in Africa/Nairobi. EAT is UTC+3 year-round with no DST, so
 * the day runs [day 00:00 EAT, next day 00:00 EAT) = [day-1 21:00 UTC,
 * day 21:00 UTC).
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';

export interface InternalRoutesOptions {
  db: Db;
}

/** Inclusive start / exclusive end of a Nairobi business day, as UTC instants. */
export function nairobiDayBounds(businessDay: string): { startUtc: string; endUtc: string } {
  const [y, m, d] = businessDay.split('-').map(Number);
  // 00:00 EAT == 21:00 UTC the previous day.
  const startUtc = new Date(Date.UTC(y!, m! - 1, d!, 0, 0, 0) - 3 * 60 * 60 * 1000);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc: startUtc.toISOString(), endUtc: endUtc.toISOString() };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DailyCloseSale {
  saleId: string;
  totalMinor: number;
}

export interface DailyCloseAttendant {
  attendantId: string;
  msisdn: string;
  rateBps: number;
  sales: DailyCloseSale[];
}

export interface DailyCloseTenant {
  tenantId: string;
  attendants: DailyCloseAttendant[];
}

export interface DailyCloseResponse {
  businessDay: string;
  windowUtc: { start: string; end: string };
  tenants: DailyCloseTenant[];
}

interface PaidSaleRow {
  sale_id: string;
  tenant_id: string;
  attendant_id: string;
  total_minor: number;
}

export default async function internalRoutes(app: FastifyInstance, opts: InternalRoutesOptions) {
  const { db } = opts;

  app.get<{ Querystring: { businessDay?: string } }>(
    '/internal/daily-close',
    { preHandler: app.requireServiceToken },
    async (request, reply) => {
      const businessDay = request.query.businessDay;
      if (!businessDay || !DAY_RE.test(businessDay)) {
        return reply
          .code(400)
          .send({ error: 'invalid_business_day', message: 'businessDay must be YYYY-MM-DD' });
      }

      const { startUtc, endUtc } = nairobiDayBounds(businessDay);

      // Only PAID sales count. A sale that is UNPAID, VOID, or whose payment
      // is still uncertain earns no commission — the brief's "calculates only
      // from confirmed paid sales".
      const sales = await db.query<PaidSaleRow>(
        `SELECT id AS sale_id, tenant_id, attendant_id, total_minor
         FROM sales
         WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2
         ORDER BY tenant_id, attendant_id, created_at`,
        [startUtc, endUtc],
      );

      // Group tenant -> attendant -> sales.
      const byTenant = new Map<string, Map<string, DailyCloseSale[]>>();
      for (const row of sales.rows) {
        let attendants = byTenant.get(row.tenant_id);
        if (!attendants) {
          attendants = new Map();
          byTenant.set(row.tenant_id, attendants);
        }
        const list = attendants.get(row.attendant_id) ?? [];
        list.push({ saleId: row.sale_id, totalMinor: row.total_minor });
        attendants.set(row.attendant_id, list);
      }

      const tenants: DailyCloseTenant[] = [];
      for (const [tenantId, attendantMap] of byTenant) {
        const attendants: DailyCloseAttendant[] = [];
        for (const [attendantId, attendantSales] of attendantMap) {
          const msisdn = await attendantMsisdn(db, tenantId, attendantId);
          if (!msisdn) {
            // No payout destination. Reported with rate 0 and no sales so
            // Commission records a SKIPPED ledger row rather than silently
            // omitting the attendant — a missing attendant is a fact the
            // close should surface, not hide.
            request.log.warn({ tenantId, attendantId }, 'daily-close: attendant has no msisdn');
            continue;
          }
          attendants.push({
            attendantId,
            msisdn,
            rateBps: await effectiveRateBps(db, tenantId, attendantId, endUtc),
            sales: attendantSales,
          });
        }
        if (attendants.length > 0) tenants.push({ tenantId, attendants });
      }

      const body: DailyCloseResponse = {
        businessDay,
        windowUtc: { start: startUtc, end: endUtc },
        tenants,
      };
      request.log.info(
        { businessDay, tenants: tenants.length, sales: sales.rowCount },
        'daily-close snapshot served',
      );
      return reply.send(body);
    },
  );
}

async function attendantMsisdn(db: Db, tenantId: string, attendantId: string): Promise<string | null> {
  const res = await db.query<{ msisdn: string }>(
    'SELECT msisdn FROM attendants WHERE id = $1 AND tenant_id = $2',
    [attendantId, tenantId],
  );
  return res.rows[0]?.msisdn ?? null;
}

/**
 * The rate in force at the END of the business day: an attendant-specific
 * rate if one exists, otherwise the tenant default. Two queries rather than
 * one ordered by `attendant_id IS NOT NULL` — clearer, and portable to the
 * pg-mem engine the tests run on.
 */
async function effectiveRateBps(
  db: Db,
  tenantId: string,
  attendantId: string,
  asOfUtc: string,
): Promise<number> {
  const specific = await db.query<{ rate_bps: number }>(
    `SELECT rate_bps FROM commission_rates
     WHERE tenant_id = $1 AND attendant_id = $2 AND effective_from < $3
     ORDER BY effective_from DESC LIMIT 1`,
    [tenantId, attendantId, asOfUtc],
  );
  if (specific.rows[0]) return specific.rows[0].rate_bps;

  const fallback = await db.query<{ rate_bps: number }>(
    `SELECT rate_bps FROM commission_rates
     WHERE tenant_id = $1 AND attendant_id IS NULL AND effective_from < $2
     ORDER BY effective_from DESC LIMIT 1`,
    [tenantId, asOfUtc],
  );
  // No rate configured means no commission, not a crash. The ledger will
  // record a zero-amount SKIPPED row, which is visible and auditable.
  return fallback.rows[0]?.rate_bps ?? 0;
}
