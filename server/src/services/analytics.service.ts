import { OrderStatus, PaymentMethod, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { addDays, businessDateOnly, businessDayKey, startOfBusinessDay } from '../lib/businessDay';
import { cached } from '../lib/cache';
import { outstandingAgeing } from './finance.service';
import { healthDistribution } from './retailer-health.service';

// Dashboards are read-only aggregations. A short server-side TTL makes repeat
// loads instant and, with coalescing, collapses concurrent loads into one
// computation. 20s keeps them "near-real-time" (SRS §10) and sits well under
// the 60s web client refetch.
const DASH_TTL_MS = 20_000;

// SRS §10 + D28 Day/Week/Month toggle. All figures computed live (real-time
// per §10 impl note); the web layer caches via React Query.
export type Period = 'day' | 'week' | 'month';

// Rolling window aligned to Asia/Karachi calendar days, today included. Returns
// an instant lower bound (for timestamptz columns) and a date-only lower bound
// (for @db.Date columns) for the last `days` business days.
function periodRange(p: Period): { gte: Date; gteDate: Date; days: number } {
  const days = p === 'day' ? 1 : p === 'week' ? 7 : 30;
  const gte = new Date(startOfBusinessDay().getTime() - (days - 1) * 86_400_000);
  const gteDate = addDays(businessDateOnly(), -(days - 1));
  return { gte, gteDate, days };
}

// @db.Date values are stored at UTC midnight of the local date, so the ISO date
// slice is already the PKT calendar day.
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Per-day revenue series: delivered/partial order value + POS sales. Orders are
// keyed off deliveryDate (@db.Date); POS off createdAt (timestamptz, keyed in
// the business zone so late-evening sales land on the correct day).
async function revenueTrend(gteInstant: Date, gteDate: Date) {
  const [orders, pos] = await Promise.all([
    prisma.order.findMany({
      where: { status: { in: ['delivered', 'partial'] }, deliveryDate: { gte: gteDate } },
      select: { deliveryDate: true, totalValuePkr: true },
    }),
    prisma.posSale.findMany({
      where: { voided: false, createdAt: { gte: gteInstant } },
      select: { createdAt: true, totalPkr: true },
    }),
  ]);
  const map = new Map<string, number>();
  for (const o of orders) {
    const k = dayKey(o.deliveryDate);
    map.set(k, (map.get(k) ?? 0) + Number(o.totalValuePkr));
  }
  for (const s of pos) {
    const k = businessDayKey(s.createdAt);
    map.set(k, (map.get(k) ?? 0) + Number(s.totalPkr));
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value: Math.round(value) }));
}

async function computeSuperAdmin(period: Period) {
  const { gte, gteDate } = periodRange(period);
  const startToday = startOfBusinessDay();

  const [funnelRows, trend, posAgg, ageing, items, zoneRows, activeSalesmen] =
    await Promise.all([
      prisma.order.groupBy({
        by: ['status'],
        where: { orderDate: { gte: gteDate } },
        _count: { _all: true },
      }),
      revenueTrend(gte, gteDate),
      prisma.posSale.aggregate({
        where: { voided: false, createdAt: { gte: startToday } },
        _sum: { totalPkr: true },
      }),
      outstandingAgeing(),
      prisma.orderItem.groupBy({
        by: ['productId'],
        where: { order: { orderDate: { gte: gteDate }, status: { not: 'cancelled' } } },
        _sum: { qtyOrdered: true },
      }),
      prisma.order.groupBy({
        by: ['zoneId'],
        where: { orderDate: { gte: gteDate }, status: { not: 'cancelled' } },
        _sum: { totalValuePkr: true },
      }),
      prisma.visit.findMany({
        where: { visitedAt: { gte: startToday } },
        select: { salesmanId: true },
        distinct: ['salesmanId'],
      }),
    ]);

  const funnel: Record<string, number> = {};
  for (const f of funnelRows) funnel[f.status] = f._count._all;
  const assignedTotal =
    (funnel[OrderStatus.assigned] ?? 0) +
    (funnel[OrderStatus.delivered] ?? 0) +
    (funnel[OrderStatus.partial] ?? 0) +
    (funnel[OrderStatus.failed] ?? 0);
  const deliveredTotal = (funnel[OrderStatus.delivered] ?? 0) + (funnel[OrderStatus.partial] ?? 0);

  const products = await prisma.product.findMany({
    where: { id: { in: items.map((i) => i.productId) } },
    select: { id: true, name: true },
  });
  const pname = new Map(products.map((p) => [p.id, p.name]));
  const topSkus = items
    .map((i) => ({ name: pname.get(i.productId) ?? i.productId, qty: i._sum.qtyOrdered ?? 0 }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 8);

  const zones = await prisma.zone.findMany({
    where: { id: { in: zoneRows.map((z) => z.zoneId) } },
    select: { id: true, name: true },
  });
  const zname = new Map(zones.map((z) => [z.id, z.name]));
  const zoneSales = zoneRows.map((z) => ({
    zone: zname.get(z.zoneId) ?? z.zoneId,
    value: Math.round(Number(z._sum.totalValuePkr ?? 0)),
  }));

  const revenueTotal = trend.reduce((s, t) => s + t.value, 0);
  return {
    period,
    kpis: {
      revenueTotalPkr: revenueTotal,
      posRevenueTodayPkr: Math.round(Number(posAgg._sum.totalPkr ?? 0)),
      outstandingTotalPkr: ageing.grandTotalPkr,
      activeSalesmenToday: activeSalesmen.length,
      deliverySuccessRate:
        assignedTotal > 0 ? Math.round((deliveredTotal / assignedTotal) * 100) : 0,
    },
    ordersFunnel: {
      pending: funnel[OrderStatus.pending] ?? 0,
      assigned: funnel[OrderStatus.assigned] ?? 0,
      delivered: funnel[OrderStatus.delivered] ?? 0,
      failed: funnel[OrderStatus.failed] ?? 0,
    },
    revenueTrend: trend,
    topSkus,
    zoneSales,
  };
}

async function computeSalesManager(period: Period) {
  const { gteDate } = periodRange(period);
  const startTodayDate = businessDateOnly();

  const [pending, approvals, failedToday, zoneRows, health, leaderboardRows] =
    await Promise.all([
      prisma.order.aggregate({
        where: { status: OrderStatus.pending },
        _count: { _all: true },
        _sum: { totalValuePkr: true },
      }),
      prisma.discountApproval.count({ where: { status: 'pending' } }),
      prisma.order.count({
        where: { status: OrderStatus.failed, deliveryDate: { gte: startTodayDate } },
      }),
      prisma.order.groupBy({
        by: ['zoneId'],
        where: { orderDate: { gte: gteDate }, status: { not: 'cancelled' } },
        _sum: { totalValuePkr: true },
      }),
      healthDistribution(),
      prisma.order.groupBy({
        by: ['salesmanId'],
        where: { orderDate: { gte: gteDate }, status: { not: 'cancelled' } },
        _sum: { totalValuePkr: true },
      }),
    ]);

  const sm = await prisma.user.findMany({
    where: { id: { in: leaderboardRows.map((r) => r.salesmanId) } },
    select: { id: true, name: true },
  });
  const smName = new Map(sm.map((u) => [u.id, u.name]));
  const zones = await prisma.zone.findMany({
    where: { id: { in: zoneRows.map((z) => z.zoneId) } },
    select: { id: true, name: true },
  });
  const zname = new Map(zones.map((z) => [z.id, z.name]));

  return {
    period,
    kpis: {
      pendingAwaitingAssignment: pending._count._all,
      pendingValuePkr: Math.round(Number(pending._sum.totalValuePkr ?? 0)),
      discountApprovalsPending: approvals,
      failedDeliveriesToday: failedToday,
    },
    orderValueByZone: zoneRows.map((z) => ({
      zone: zname.get(z.zoneId) ?? z.zoneId,
      value: Math.round(Number(z._sum.totalValuePkr ?? 0)),
    })),
    retailerHealth: health,
    salesmanLeaderboard: leaderboardRows
      .map((r) => ({
        name: smName.get(r.salesmanId) ?? r.salesmanId,
        value: Math.round(Number(r._sum.totalValuePkr ?? 0)),
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10),
  };
}

async function computeInventory() {
  const stock = await prisma.warehouseStock.findMany({
    where: { product: { isActive: true, isDeleted: false } },
    include: { product: { select: { name: true, sku: true } } },
    orderBy: { product: { name: 'asc' } },
  });
  return {
    stockLevels: stock.map((s) => ({
      name: s.product.name,
      sku: s.product.sku,
      qty: s.quantityOnHand,
      threshold: s.lowStockThreshold,
      low: s.quantityOnHand <= s.lowStockThreshold,
    })),
    lowStockCount: stock.filter((s) => s.quantityOnHand <= s.lowStockThreshold).length,
  };
}

async function computeFinance(period: Period) {
  const { gte, gteDate } = periodRange(period);
  const [unrecon, methodRows, ageing, posByDay, ordersRev, expensesAgg, purchasesAgg, ledgerByDir] =
    await Promise.all([
      prisma.payment.aggregate({
        where: { reconciled: false, method: { not: PaymentMethod.credit } },
        _sum: { amountPkr: true },
      }),
      prisma.payment.groupBy({
        by: ['method'],
        where: { collectedAt: { gte } },
        _sum: { amountPkr: true },
      }),
      outstandingAgeing(),
      prisma.posSale.findMany({
        where: { voided: false, createdAt: { gte } },
        select: { createdAt: true, totalPkr: true },
      }),
      // Recognised sales revenue this period: delivered/partial field orders.
      prisma.order.aggregate({
        where: { status: { in: [OrderStatus.delivered, OrderStatus.partial] }, orderDate: { gte: gteDate } },
        _sum: { totalValuePkr: true },
      }),
      // Operating expenses this period (soft-deleted excluded).
      prisma.expense.aggregate({
        where: { expenseDate: { gte: gteDate }, isDeleted: false },
        _sum: { amountPkr: true },
      }),
      // Stock purchased from the principal company this period.
      prisma.supplierPurchase.aggregate({
        where: { purchaseDate: { gte: gteDate } },
        _sum: { totalPkr: true },
      }),
      // Current amount owed to suppliers (all-time balance, not period-scoped):
      // debits (purchases, fare) raise it, credits (funds paid, incentives) lower it.
      prisma.supplierLedgerEntry.groupBy({ by: ['direction'], _sum: { amountPkr: true } }),
    ]);
  const method: Record<string, number> = { cash: 0, credit: 0, digital: 0 };
  for (const m of methodRows) method[m.method] = Math.round(Number(m._sum.amountPkr ?? 0));
  const posMap = new Map<string, number>();
  for (const s of posByDay) {
    const k = businessDayKey(s.createdAt);
    posMap.set(k, (posMap.get(k) ?? 0) + Number(s.totalPkr));
  }

  const posRevenuePkr = Math.round(posByDay.reduce((s, x) => s + Number(x.totalPkr), 0));
  const ordersRevenuePkr = Math.round(Number(ordersRev._sum.totalValuePkr ?? 0));
  const revenuePkr = posRevenuePkr + ordersRevenuePkr;
  const expensesPkr = Math.round(Number(expensesAgg._sum.amountPkr ?? 0));
  const purchasesPkr = Math.round(Number(purchasesAgg._sum.totalPkr ?? 0));
  let debit = 0;
  let credit = 0;
  for (const g of ledgerByDir) {
    if (g.direction === 'debit') debit = Number(g._sum.amountPkr ?? 0);
    else credit = Number(g._sum.amountPkr ?? 0);
  }
  const supplierPayablePkr = Math.round(debit - credit);

  return {
    period,
    kpis: {
      revenuePkr,
      ordersRevenuePkr,
      posRevenuePkr,
      cashToReconcilePkr: Math.round(Number(unrecon._sum.amountPkr ?? 0)),
      outstandingTotalPkr: ageing.grandTotalPkr,
      supplierPayablePkr,
      expensesPkr,
      purchasesPkr,
      // Rough operating net for the period: revenue − stock purchased − expenses.
      netPkr: revenuePkr - purchasesPkr - expensesPkr,
    },
    ageing: ageing.buckets,
    paymentMethodBreakdown: method,
    posDailyRevenue: [...posMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value: Math.round(value) })),
  };
}

// Public dashboard entry points — same signatures as before, now served from
// a 20s TTL cache with request coalescing. Callers (controllers, cron) are
// unchanged.
export const superAdmin = (period: Period) =>
  cached(`an:sa:${period}`, DASH_TTL_MS, () => computeSuperAdmin(period));
export const salesManager = (period: Period) =>
  cached(`an:sm:${period}`, DASH_TTL_MS, () => computeSalesManager(period));
export const inventory = () => cached('an:inv', DASH_TTL_MS, computeInventory);
export const finance = (period: Period) =>
  cached(`an:fin:${period}`, DASH_TTL_MS, () => computeFinance(period));

export { Prisma };
