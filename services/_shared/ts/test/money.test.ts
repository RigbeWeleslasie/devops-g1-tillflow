import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinorUnits,
  InvalidMoneyError,
  commissionForSale,
  lineItemTotal,
  sumMinor,
  formatMinor,
} from '../src/money.js';

test('toMinorUnits rejects floats', () => {
  assert.throws(() => toMinorUnits(10.5), InvalidMoneyError);
});

test('toMinorUnits rejects negative amounts', () => {
  assert.throws(() => toMinorUnits(-1), InvalidMoneyError);
});

test('toMinorUnits accepts zero and positive integers', () => {
  assert.equal(toMinorUnits(0), 0);
  assert.equal(toMinorUnits(150000), 150000);
});

test('commissionForSale floors — the one documented rounding rule', () => {
  // 199 * 500 / 10000 = 9.95 -> floor -> 9
  assert.equal(commissionForSale(toMinorUnits(199), 500), 9);
  // exact division stays exact
  assert.equal(commissionForSale(toMinorUnits(10_000), 500), 500);
  // 0% rate -> 0 commission, not an error
  assert.equal(commissionForSale(toMinorUnits(10_000), 0), 0);
});

test('commissionForSale rejects an out-of-range basis-point rate', () => {
  assert.throws(() => commissionForSale(toMinorUnits(1000), 10_001), InvalidMoneyError);
  assert.throws(() => commissionForSale(toMinorUnits(1000), -1), InvalidMoneyError);
});

test('lineItemTotal is exact integer multiplication', () => {
  assert.equal(lineItemTotal(toMinorUnits(250), 3), 750);
});

test('lineItemTotal rejects a zero or fractional quantity', () => {
  assert.throws(() => lineItemTotal(toMinorUnits(250), 0), InvalidMoneyError);
  assert.throws(() => lineItemTotal(toMinorUnits(250), 1.5), InvalidMoneyError);
});

test('sumMinor sums an array of minor-unit values', () => {
  const items = [toMinorUnits(100), toMinorUnits(250), toMinorUnits(9)];
  assert.equal(sumMinor(items), 359);
});

test('formatMinor is display-only formatting, not a math primitive', () => {
  assert.equal(formatMinor(toMinorUnits(150000)), 'KES 1500.00');
  assert.equal(formatMinor(toMinorUnits(9)), 'KES 0.09');
});
