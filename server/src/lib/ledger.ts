// Pure, DB-free ledger math for the upstream company account (S10).
// Balance convention: positive = amount OWED to the company (a payable).
// Debits (stock_purchase, fare) increase it; credits (funds_paid, incentive,
// discount) decrease it. Negative balance = advance/credit held with company.

export type LedgerDir = 'debit' | 'credit';
export type LedgerType =
  | 'stock_purchase'
  | 'fare'
  | 'funds_paid'
  | 'incentive'
  | 'discount'
  | 'adjustment'
  | 'opening_balance';

const IMPLIED: Partial<Record<LedgerType, LedgerDir>> = {
  stock_purchase: 'debit',
  fare: 'debit',
  funds_paid: 'credit',
  incentive: 'credit',
  discount: 'credit',
};

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Direction for an entry type; adjustment/opening_balance must pass explicit. */
export function directionForType(type: LedgerType, explicit?: LedgerDir): LedgerDir {
  const implied = IMPLIED[type];
  if (implied) return implied;
  if (!explicit) {
    throw new Error(`direction required for entry type "${type}"`);
  }
  return explicit;
}

function signed(direction: LedgerDir, amount: number): number {
  return direction === 'debit' ? amount : -amount;
}

/** Cumulative balance after each chronological entry. */
export function runningBalance(rows: { direction: LedgerDir; amountPkr: number }[]): number[] {
  let acc = 0;
  return rows.map((r) => {
    acc = round2(acc + signed(r.direction, r.amountPkr));
    return acc;
  });
}

export type LedgerSummary = {
  purchasesPkr: number;
  farePkr: number;
  paidPkr: number;
  incentivePkr: number;
  discountPkr: number;
  adjustmentPkr: number; // signed: debit positive, credit negative
  openingPkr: number; // signed
  balancePkr: number;
};

export function summarizeLedger(
  entries: { entryType: LedgerType; direction: LedgerDir; amountPkr: number }[]
): LedgerSummary {
  const s: LedgerSummary = {
    purchasesPkr: 0,
    farePkr: 0,
    paidPkr: 0,
    incentivePkr: 0,
    discountPkr: 0,
    adjustmentPkr: 0,
    openingPkr: 0,
    balancePkr: 0,
  };
  for (const e of entries) {
    s.balancePkr = round2(s.balancePkr + signed(e.direction, e.amountPkr));
    switch (e.entryType) {
      case 'stock_purchase':
        s.purchasesPkr = round2(s.purchasesPkr + e.amountPkr);
        break;
      case 'fare':
        s.farePkr = round2(s.farePkr + e.amountPkr);
        break;
      case 'funds_paid':
        s.paidPkr = round2(s.paidPkr + e.amountPkr);
        break;
      case 'incentive':
        s.incentivePkr = round2(s.incentivePkr + e.amountPkr);
        break;
      case 'discount':
        s.discountPkr = round2(s.discountPkr + e.amountPkr);
        break;
      case 'adjustment':
        s.adjustmentPkr = round2(s.adjustmentPkr + signed(e.direction, e.amountPkr));
        break;
      case 'opening_balance':
        s.openingPkr = round2(s.openingPkr + signed(e.direction, e.amountPkr));
        break;
    }
  }
  return s;
}
