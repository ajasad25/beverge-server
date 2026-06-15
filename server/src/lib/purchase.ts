// Pure, DB-free math for supplier stock purchases and inventory valuation (S10).
import { round2 } from './ledger';

export function lineTotal(qtyReceived: number, unitCostPkr: number): number {
  return round2(qtyReceived * unitCostPkr);
}

export type PurchaseLineInput = { qtyReceived: number; unitCostPkr: number };

export function purchaseTotals(
  lines: PurchaseLineInput[],
  farePkr = 0,
  discountPkr = 0
): { subtotalPkr: number; totalPkr: number } {
  const subtotalPkr = round2(
    lines.reduce((sum, l) => sum + lineTotal(l.qtyReceived, l.unitCostPkr), 0)
  );
  const totalPkr = round2(subtotalPkr + farePkr - discountPkr);
  return { subtotalPkr, totalPkr };
}

export function valuationValue(qty: number, latestUnitCostPkr: number | null): number {
  if (latestUnitCostPkr == null) return 0;
  return round2(qty * latestUnitCostPkr);
}
