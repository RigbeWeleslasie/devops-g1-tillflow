/**
 * Business-day arithmetic in Africa/Nairobi.
 *
 * EAT is UTC+3 all year with no daylight saving, which is why this is fixed
 * arithmetic rather than an Intl timezone lookup: the offset cannot change
 * under us, and a pure function is testable at any instant.
 *
 * The daily close fires at 00:15 EAT (infra/data.tf's scheduler) and closes
 * the day that has just ENDED — the previous calendar day in Nairobi. The
 * trigger message may name an explicit businessDay instead, which is what
 * makes a replay or a drill reproducible.
 */

export const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isBusinessDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  // Reject impossible dates that match the shape (2026-02-31).
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

/** The Nairobi calendar date at a given instant. */
export function nairobiDate(at: Date): string {
  const shifted = new Date(at.getTime() + EAT_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The day a close running at `at` should settle: the day before the current
 * Nairobi date. At 00:15 EAT on the 15th that is the 14th — the day whose
 * sales have finished.
 */
export function businessDayToClose(at: Date): string {
  const shifted = new Date(at.getTime() + EAT_OFFSET_MS - 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Inclusive start / exclusive end of a Nairobi business day, as UTC instants. */
export function nairobiDayBounds(businessDay: string): { startUtc: Date; endUtc: Date } {
  const [y, m, d] = businessDay.split('-').map(Number);
  const startUtc = new Date(Date.UTC(y!, m! - 1, d!, 0, 0, 0) - EAT_OFFSET_MS);
  return { startUtc, endUtc: new Date(startUtc.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * The Commission SLI deadline: payouts for a business day must reach a
 * terminal state by 06:30 EAT the following morning
 * (docs/slo-error-budgets.md).
 */
export function payoutDeadline(businessDay: string): Date {
  const { endUtc } = nairobiDayBounds(businessDay);
  return new Date(endUtc.getTime() + 6.5 * 60 * 60 * 1000);
}
