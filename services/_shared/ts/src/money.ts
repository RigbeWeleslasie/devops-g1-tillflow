/**
 * Money helpers — integer minor units end to end, no floats.
 *
 * "Minor units" = the smallest currency unit (KES cents: 1 KES = 100 minor
 * units). Every amount that crosses a service boundary, sits in a database
 * column, or gets summed for commission MUST be a `MinorUnits` value:
 * a non-negative, safe-integer `number`. Never a float, never a string
 * fraction, never `amount / 100` for anything other than display.
 *
 * Rounding rule (the "one place" ADR 0006 requires — this is that place):
 *   commission = floor(saleTotalMinor * rateBps / 10000)
 * computed PER SALE, then summed. Rates are basis points (1 bps = 0.01%),
 * so a 5% rate is `rateBps = 500`. Flooring means the platform never rounds
 * a commission UP in the attendant's favour at the till's expense; the
 * (small, bounded) leftover fraction stays with the tenant.
 */

export type MinorUnits = number & { readonly __brand: 'MinorUnits' };

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

/** Non-negative safe-integer check. Throws, does not silently coerce. */
export function toMinorUnits(value: unknown): MinorUnits {
  if (typeof value !== 'number') {
    throw new InvalidMoneyError(`amount must be a number, got ${typeof value}`);
  }
  if (!Number.isInteger(value)) {
    throw new InvalidMoneyError(`amount must be an integer minor-unit value, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new InvalidMoneyError(`amount exceeds the safe integer range: ${value}`);
  }
  if (value < 0) {
    throw new InvalidMoneyError(`amount must not be negative, got ${value}`);
  }
  return value as MinorUnits;
}

/** Same as toMinorUnits, but allows zero-or-positive AND rejects zero (for things that must be > 0, e.g. a line item price... actually price can be 0 for a free item, quantity must be > 0). Kept separate so call sites say what they mean. */
export function toPositiveMinorUnits(value: unknown): MinorUnits {
  const v = toMinorUnits(value);
  if (v <= 0) {
    throw new InvalidMoneyError(`amount must be greater than zero, got ${v}`);
  }
  return v;
}

export function addMinor(a: MinorUnits, b: MinorUnits): MinorUnits {
  return toMinorUnits(a + b);
}

export function sumMinor(values: readonly MinorUnits[]): MinorUnits {
  return toMinorUnits(values.reduce((acc, v) => acc + v, 0));
}

/** Line-item total: unit price (minor units) × integer quantity. Both operands already integers, so the product is exact — no rounding step needed here. */
export function lineItemTotal(unitPriceMinor: MinorUnits, quantity: number): MinorUnits {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InvalidMoneyError(`quantity must be a positive integer, got ${quantity}`);
  }
  return toMinorUnits(unitPriceMinor * quantity);
}

/**
 * Commission for one sale. rateBps is basis points (500 = 5.00%).
 * `Math.floor` on an already-integer numerator/denominator division is the
 * single rounding rule for the whole platform — see the file header.
 */
export function commissionForSale(saleTotalMinor: MinorUnits, rateBps: number): MinorUnits {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new InvalidMoneyError(`rateBps must be an integer in [0, 10000], got ${rateBps}`);
  }
  return toMinorUnits(Math.floor((saleTotalMinor * rateBps) / 10_000));
}

/** Display only — never feed this back into a calculation or a DB write. */
export function formatMinor(amount: MinorUnits, currency = 'KES'): string {
  const major = Math.trunc(amount / 100);
  const minor = String(amount % 100).padStart(2, '0');
  return `${currency} ${major}.${minor}`;
}
