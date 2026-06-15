import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { priceWasRevised } from './pricing';

// PRICE-1: did the server's authoritative recompute change the line price the
// salesman captured offline? (Drives order_items.price_revised_on_sync.)

test('no captured price → not revised (server has nothing to compare against)', () => {
  assert.equal(priceWasRevised(new Prisma.Decimal(100)), false);
  assert.equal(priceWasRevised(new Prisma.Decimal(100), null), false);
  assert.equal(priceWasRevised(new Prisma.Decimal(100), undefined), false);
});

test('captured equals server → not revised', () => {
  assert.equal(priceWasRevised(new Prisma.Decimal(100), 100), false);
  assert.equal(priceWasRevised(new Prisma.Decimal('100.00'), 100), false);
});

test('captured differs from server → revised', () => {
  assert.equal(priceWasRevised(new Prisma.Decimal(95), 100), true); // price dropped on sync
  assert.equal(priceWasRevised(new Prisma.Decimal(100), 99.99), true);
});

test('sub-paisa differences are ignored (PKR is 2 d.p.)', () => {
  assert.equal(priceWasRevised(new Prisma.Decimal('100.00'), 100.004), false);
});
