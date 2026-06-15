import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directionForType, runningBalance, summarizeLedger, round2 } from './ledger';

test('directionForType: typed entries imply direction', () => {
  assert.equal(directionForType('stock_purchase'), 'debit');
  assert.equal(directionForType('fare'), 'debit');
  assert.equal(directionForType('funds_paid'), 'credit');
  assert.equal(directionForType('incentive'), 'credit');
  assert.equal(directionForType('discount'), 'credit');
});

test('directionForType: adjustment/opening require explicit direction', () => {
  assert.equal(directionForType('adjustment', 'credit'), 'credit');
  assert.equal(directionForType('opening_balance', 'debit'), 'debit');
  assert.throws(() => directionForType('adjustment'), /direction required/i);
});

test('runningBalance accumulates debit(+) and credit(-)', () => {
  const rows = [
    { direction: 'debit' as const, amountPkr: 100000 }, // purchase
    { direction: 'debit' as const, amountPkr: 28750 }, // fare
    { direction: 'credit' as const, amountPkr: 50000 }, // paid
  ];
  assert.deepEqual(runningBalance(rows), [100000, 128750, 78750]);
});

test('runningBalance can go negative (advance with company)', () => {
  const rows = [
    { direction: 'debit' as const, amountPkr: 10000 },
    { direction: 'credit' as const, amountPkr: 25000 },
  ];
  assert.deepEqual(runningBalance(rows), [10000, -15000]);
});

test('summarizeLedger buckets by type and computes balance', () => {
  const s = summarizeLedger([
    { entryType: 'stock_purchase', direction: 'debit', amountPkr: 100000 },
    { entryType: 'fare', direction: 'debit', amountPkr: 28750 },
    { entryType: 'discount', direction: 'credit', amountPkr: 2000 },
    { entryType: 'funds_paid', direction: 'credit', amountPkr: 50000 },
    { entryType: 'incentive', direction: 'credit', amountPkr: 1500 },
    { entryType: 'opening_balance', direction: 'debit', amountPkr: 5000 },
  ]);
  assert.equal(s.purchasesPkr, 100000);
  assert.equal(s.farePkr, 28750);
  assert.equal(s.discountPkr, 2000);
  assert.equal(s.paidPkr, 50000);
  assert.equal(s.incentivePkr, 1500);
  assert.equal(s.openingPkr, 5000);
  // balance = (100000+28750+5000) - (2000+50000+1500) = 80250
  assert.equal(s.balancePkr, 80250);
});

test('round2 avoids float drift', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
});
