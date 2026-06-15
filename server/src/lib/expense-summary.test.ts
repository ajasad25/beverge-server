import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeExpenses } from './expense-summary';

test('summarizeExpenses rolls up by category, by month, and total', () => {
  const r = summarizeExpenses([
    { categoryId: 'c1', categoryName: 'Salaries', amountPkr: 50000, expenseDate: '2026-05-03' },
    { categoryId: 'c1', categoryName: 'Salaries', amountPkr: 10000, expenseDate: '2026-06-01' },
    { categoryId: 'c2', categoryName: 'Rent', amountPkr: 20000, expenseDate: '2026-05-10' },
  ]);
  assert.equal(r.totalPkr, 80000);
  assert.deepEqual(r.byCategory.find((c) => c.categoryId === 'c1'), {
    categoryId: 'c1',
    categoryName: 'Salaries',
    amountPkr: 60000,
  });
  assert.deepEqual(r.byMonth.find((m) => m.month === '2026-05'), { month: '2026-05', amountPkr: 70000 });
  assert.deepEqual(r.byMonth.find((m) => m.month === '2026-06'), { month: '2026-06', amountPkr: 10000 });
});

test('summarizeExpenses sorts categories desc and months asc', () => {
  const r = summarizeExpenses([
    { categoryId: 'c1', categoryName: 'Small', amountPkr: 100, expenseDate: '2026-06-01' },
    { categoryId: 'c2', categoryName: 'Big', amountPkr: 900, expenseDate: '2026-04-01' },
  ]);
  assert.equal(r.byCategory[0]?.categoryName, 'Big');
  assert.equal(r.byMonth[0]?.month, '2026-04');
});

test('summarizeExpenses handles empty', () => {
  const r = summarizeExpenses([]);
  assert.equal(r.totalPkr, 0);
  assert.deepEqual(r.byCategory, []);
  assert.deepEqual(r.byMonth, []);
});
