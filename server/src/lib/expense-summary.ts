// Pure, DB-free expense rollups (S10).
import { round2 } from './ledger';

export type ExpenseRow = {
  categoryId: string;
  categoryName: string;
  amountPkr: number;
  expenseDate: string; // ISO date (YYYY-MM-DD...)
};

export function summarizeExpenses(rows: ExpenseRow[]): {
  byCategory: { categoryId: string; categoryName: string; amountPkr: number }[];
  byMonth: { month: string; amountPkr: number }[];
  totalPkr: number;
} {
  const cat = new Map<string, { categoryId: string; categoryName: string; amountPkr: number }>();
  const mon = new Map<string, number>();
  let totalPkr = 0;
  for (const r of rows) {
    totalPkr = round2(totalPkr + r.amountPkr);
    const c = cat.get(r.categoryId) ?? {
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      amountPkr: 0,
    };
    c.amountPkr = round2(c.amountPkr + r.amountPkr);
    cat.set(r.categoryId, c);
    const m = r.expenseDate.slice(0, 7);
    mon.set(m, round2((mon.get(m) ?? 0) + r.amountPkr));
  }
  return {
    byCategory: [...cat.values()].sort((a, b) => b.amountPkr - a.amountPkr),
    byMonth: [...mon.entries()]
      .map(([month, amountPkr]) => ({ month, amountPkr }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    totalPkr,
  };
}
