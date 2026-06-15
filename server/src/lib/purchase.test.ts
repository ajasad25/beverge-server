import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotal, purchaseTotals, valuationValue } from './purchase';

test('lineTotal multiplies qty × unit cost, rounded', () => {
  assert.equal(lineTotal(96, 27.5), 2640);
  assert.equal(lineTotal(3, 33.33), 99.99);
});

test('purchaseTotals sums lines + fare − discount', () => {
  const r = purchaseTotals(
    [
      { qtyReceived: 96, unitCostPkr: 100 },
      { qtyReceived: 4, unitCostPkr: 50 },
    ],
    28750,
    2000
  );
  assert.equal(r.subtotalPkr, 9800); // 9600 + 200
  assert.equal(r.totalPkr, 36550); // 9800 + 28750 - 2000
});

test('purchaseTotals defaults fare/discount to 0', () => {
  const r = purchaseTotals([{ qtyReceived: 10, unitCostPkr: 10 }], 0, 0);
  assert.equal(r.subtotalPkr, 100);
  assert.equal(r.totalPkr, 100);
});

test('valuationValue = qty × latest cost; null cost => 0', () => {
  assert.equal(valuationValue(120, 27.5), 3300);
  assert.equal(valuationValue(120, null), 0);
});
