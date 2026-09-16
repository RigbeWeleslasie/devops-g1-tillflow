/**
 * The deterministic scenario table from ADR 0005 — the single source of truth
 * for failure-drill setup in docs/runbook.md and evidence/payments-integrity/.
 *
 * A scenario is selected by the LAST TWO DIGITS OF THE SHILLING AMOUNT, or by
 * an explicit hint (the `X-Fake-Scenario` header). Shillings, not cents:
 * Daraja only accepts whole-shilling amounts, so a cents-based key (the ADR's
 * first draft) could never reach a fake Daraja over the wire. KES 103 is a
 * timeout whether the fake is in-process or behind HTTP.
 *
 * No randomness anywhere: the same request always produces the same outcome.
 */

export type FakeScenario =
  | 'success'
  | 'cancelled'
  | 'insufficient_funds'
  | 'timeout'
  | 'duplicate_callback'
  | 'delayed_callback';

/** Keyed on `KES % 100`. Any other last-two-digits is ordinary money → success. */
export const SCENARIO_BY_KES_SUFFIX: Readonly<Record<number, FakeScenario>> = {
  0: 'success',
  1: 'cancelled',
  2: 'insufficient_funds',
  3: 'timeout',
  4: 'duplicate_callback',
  5: 'delayed_callback',
};

export const ALL_SCENARIOS: readonly FakeScenario[] = [
  'success',
  'cancelled',
  'insufficient_funds',
  'timeout',
  'duplicate_callback',
  'delayed_callback',
];

export function isFakeScenario(value: unknown): value is FakeScenario {
  return typeof value === 'string' && (ALL_SCENARIOS as readonly string[]).includes(value);
}

/**
 * Hint wins over amount. An unknown hint is an error, not a silent fallback:
 * a drill that asks for a scenario that doesn't exist should fail loudly.
 *
 * `amountMinor` is integer minor units; the key is the whole-shilling part's
 * last two digits, so KES 250 (25_000) → 50 → success, KES 103 (10_300) → 03
 * → timeout. Fractional-shilling amounts are the adapter's job to refuse
 * (wire.ts minorToKes), not this function's.
 */
export function scenarioFor(amountMinor: number, hint?: string): FakeScenario {
  if (hint !== undefined && hint !== '') {
    if (!isFakeScenario(hint)) {
      throw new Error(
        `unknown fake scenario "${hint}"; expected one of ${ALL_SCENARIOS.join(', ')}`,
      );
    }
    return hint;
  }
  const kes = Math.floor(amountMinor / 100);
  return SCENARIO_BY_KES_SUFFIX[kes % 100] ?? 'success';
}
