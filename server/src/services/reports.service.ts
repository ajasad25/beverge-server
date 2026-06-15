import { prisma } from '../lib/prisma';
import { businessDayBounds, businessDayBoundsFromKey, startOfBusinessDay } from '../lib/businessDay';
import { dailyReconciliation } from './finance.service';
import { toCsv as csv } from '../lib/csv';

// SRS §17.3 Reports Centre + FI09/OR10: CSV export. Dependency-free CSV with a
// formula-injection guard + RFC4180 quoting — see lib/csv.ts. PDF is handled
// client-side via the browser print dialog (same approach as POS receipts) —
// no server PDF lib.

// fromDate/toDate are 'YYYY-MM-DD' interpreted as Asia/Karachi calendar days.
// Bounds are real instants [start-of-fromDate, end-of-toDate); they filter both
// @db.Date (orderDate) and timestamptz (createdAt/collectedAt) columns correctly
// because @db.Date values sit at UTC midnight of their local date. Default span
// is the last 30 business days through the end of today.
function parseRange(q: { fromDate?: string; toDate?: string }): { gte: Date; lt: Date } {
  const gte = q.fromDate
    ? businessDayBoundsFromKey(q.fromDate).gte
    : new Date(startOfBusinessDay().getTime() - 30 * 86_400_000);
  const lt = q.toDate ? businessDayBoundsFromKey(q.toDate).lt : businessDayBounds().lt;
  return { gte, lt };
}

// OR10: order list export with the active date range.
export async function ordersCsv(q: { fromDate?: string; toDate?: string }): Promise<string> {
  const { gte, lt } = parseRange(q);
  const orders = await prisma.order.findMany({
    where: { orderDate: { gte, lt } },
    include: {
      retailer: { select: { shopName: true } },
      salesman: { select: { name: true } },
      driver: { select: { name: true } },
    },
    orderBy: { orderDate: 'desc' },
  });
  return csv([
    ['Order Date', 'Delivery Date', 'Retailer', 'Salesman', 'Driver', 'Status', 'Total PKR'],
    ...orders.map((o) => [
      o.orderDate.toISOString().slice(0, 10),
      o.deliveryDate.toISOString().slice(0, 10),
      o.retailer.shopName,
      o.salesman.name,
      o.driver?.name ?? '',
      o.status,
      o.totalValuePkr.toString(),
    ]),
  ]);
}

// FI09: daily reconciliation export (per-driver + POS line).
export async function reconciliationCsv(date?: string): Promise<string> {
  const r = await dailyReconciliation(date);
  return csv([
    ['Reconciliation', r.date],
    [],
    ['Driver', 'Expected', 'Cash', 'Digital', 'Credit', 'Collected', 'Reconciled', 'Discrepancy'],
    ...r.drivers.map((d) => [
      d.driverName,
      d.expectedPkr,
      d.cashPkr,
      d.digitalPkr,
      d.creditPkr,
      d.collectedPkr,
      d.reconciled ? 'yes' : 'no',
      d.discrepancy ? 'YES' : '',
    ]),
    [],
    ['POS (walk-in)', '', r.pos.cashPkr, r.pos.digitalPkr, '', '', '', `${r.pos.count} sales`],
  ]);
}

// Inventory Manager stock report.
export async function stockMovementsCsv(q: {
  fromDate?: string;
  toDate?: string;
}): Promise<string> {
  const { gte, lt } = parseRange(q);
  const moves = await prisma.stockMovement.findMany({
    where: { createdAt: { gte, lt } },
    include: { product: { select: { sku: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });
  return csv([
    ['Date', 'SKU', 'Product', 'Type', 'Qty', 'Unit', 'Reason', 'Note'],
    ...moves.map((m) => [
      m.createdAt.toISOString(),
      m.product.sku,
      m.product.name,
      m.movementType,
      m.qty,
      m.unitType,
      m.reasonCode ?? '',
      m.note ?? '',
    ]),
  ]);
}

// POS daily sales report (POS24).
export async function posSalesCsv(date?: string): Promise<string> {
  // createdAt is timestamptz; a single business day is an instant window.
  const { gte, lt } = date ? businessDayBoundsFromKey(date) : businessDayBounds();
  const sales = await prisma.posSale.findMany({
    where: { createdAt: { gte, lt } },
    include: { cashier: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return csv([
    ['Time', 'Cashier', 'Method', 'Discount', 'Total PKR', 'Voided'],
    ...sales.map((s) => [
      s.createdAt.toISOString(),
      s.cashier.name,
      s.paymentMethod,
      s.discountPkr.toString(),
      s.totalPkr.toString(),
      s.voided ? 'VOID' : '',
    ]),
  ]);
}
