/**
 * The deterministic scenario table from ADR 0005 — the single source of truth
 * for failure-drill setup in docs/runbook.md and evidence/payments-integrity/.
 *
 * A scenario is selected by the amount's last two minor-unit digits
 * (amountMinor % 100) or by an explicit hint (the `X-Fake-Scenario` header).
 * No randomness anywhere: the same request always produces the same outcome.
 */

export type FakeScenario =
  | 'success'
  | 'cancelled'
  | 'insufficient_funds'
  | 'timeout'
  | 'duplicate_callback'
  | 'delayed_callback';

export const SCENARIO_BY_CENTS: Readonly<Record<number, FakeScenario>> = {
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
 * Amounts whose cents are outside the table default to success — 0.06 to 0.99
 * are ordinary money, not undefined behaviour.
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
  return SCENARIO_BY_CENTS[amountMinor % 100] ?? 'success';
}
