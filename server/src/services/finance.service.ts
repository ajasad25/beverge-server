import { OrderStatus, PaymentMethod, Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  addDays,
  businessDateOnlyFromKey,
  businessDayBounds,
  businessDayBoundsFromKey,
  businessDayKey,
} from '../lib/businessDay';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';

export type Actor = AuditActor & { role: Role };

// Filters timestamptz columns (collectedAt/createdAt), so the bounds are real
// instants delimiting the business day in Asia/Karachi. `key` is the PKT
// calendar date — derived from the input, NOT from `gte` (which is the prior
// UTC evening once the local-midnight offset is applied).
function dayRange(dateStr?: string): { gte: Date; lt: Date; key: string } {
  const { gte, lt } = dateStr ? businessDayBoundsFromKey(dateStr) : businessDayBounds();
  return { gte, lt, key: dateStr ?? businessDayKey() };
}

// SRS FI01-04: per-driver daily expected-vs-collected with method
// breakdown; discrepancy auto-flagged. POS cash is reported SEPARATELY
// from driver-collected cash (FI02 / POS21).
export async function dailyReconciliation(dateStr?: string) {
  const { gte, lt, key } = dayRange(dateStr);
  // Orders are dated on @db.Date (deliveryDate); payments on timestamptz
  // (collectedAt). Both windows describe the same business day.
  const dGte = businessDateOnlyFromKey(key);
  const dLt = addDays(dGte, 1);

  type Row = {
    driverId: string;
    driverName: string;
    expectedPkr: Prisma.Decimal;
    cashPkr: Prisma.Decimal;
    creditPkr: Prisma.Decimal;
    digitalPkr: Prisma.Decimal;
    collectedPkr: Prisma.Decimal;
    reconciled: boolean;
    discrepancy: boolean;
  };
  const byDriver = new Map<string, Row>();
  const ensure = (driverId: string, driverName: string): Row => {
    let r = byDriver.get(driverId);
    if (!r) {
      r = {
        driverId,
        driverName,
        expectedPkr: new Prisma.Decimal(0),
        cashPkr: new Prisma.Decimal(0),
        creditPkr: new Prisma.Decimal(0),
        digitalPkr: new Prisma.Decimal(0),
        collectedPkr: new Prisma.Decimal(0),
        reconciled: true,
        discrepancy: false,
      };
      byDriver.set(driverId, r);
    }
    if (!r.driverName && driverName) r.driverName = driverName;
    return r;
  };

  // Expected = value the driver actually delivered that day: full order value
  // for a DELIVERED stop, the delivered portion (Σ qtyDelivered × unit price)
  // for a PARTIAL stop. Derived from orders — NOT payment rows — so a delivered
  // order with no payment still shows as an expected amount the driver must
  // account for, and a partial isn't expected at its full value (FI01/bug17).
  const deliveredOrders = await prisma.order.findMany({
    where: {
      driverId: { not: null },
      deliveryDate: { gte: dGte, lt: dLt },
      status: { in: [OrderStatus.delivered, OrderStatus.partial] },
    },
    select: {
      driverId: true,
      status: true,
      totalValuePkr: true,
      driver: { select: { name: true } },
      items: { select: { qtyDelivered: true, effectiveUnitPrice: true } },
    },
  });
  for (const o of deliveredOrders) {
    const r = ensure(o.driverId!, o.driver?.name ?? '');
    const value =
      o.status === OrderStatus.delivered
        ? new Prisma.Decimal(o.totalValuePkr)
        : o.items.reduce(
            (s, it) => s.add(new Prisma.Decimal(it.effectiveUnitPrice).mul(it.qtyDelivered ?? 0)),
            new Prisma.Decimal(0)
          );
    r.expectedPkr = r.expectedPkr.add(value);
  }

  const payments = await prisma.payment.findMany({
    where: { collectedAt: { gte, lt } },
    include: { driver: { select: { name: true } } },
  });
  for (const p of payments) {
    const r = ensure(p.driverId, p.driver.name);
    if (p.method === PaymentMethod.cash) r.cashPkr = r.cashPkr.add(p.amountPkr);
    else if (p.method === PaymentMethod.credit) r.creditPkr = r.creditPkr.add(p.amountPkr);
    else r.digitalPkr = r.digitalPkr.add(p.amountPkr);
    // Credit is deferred, not collected cash; collected = cash + digital.
    if (p.method !== PaymentMethod.credit) r.collectedPkr = r.collectedPkr.add(p.amountPkr);
    // Only cash/digital are physically reconciled; credit deferrals don't gate
    // the day's reconciled flag (mirrors markDriverReconciled).
    if (p.method !== PaymentMethod.credit && !p.reconciled) r.reconciled = false;
  }
  const drivers = [...byDriver.values()].map((r) => ({
    ...r,
    discrepancy: !r.expectedPkr.equals(r.collectedPkr.add(r.creditPkr)),
    expectedPkr: r.expectedPkr.toString(),
    cashPkr: r.cashPkr.toString(),
    creditPkr: r.creditPkr.toString(),
    digitalPkr: r.digitalPkr.toString(),
    collectedPkr: r.collectedPkr.toString(),
  }));

  // POS cash, shown on its own line (FI02 / POS21).
  const posSales = await prisma.posSale.findMany({
    where: { createdAt: { gte, lt }, voided: false },
    select: { totalPkr: true, paymentMethod: true },
  });
  let posCash = new Prisma.Decimal(0);
  let posDigital = new Prisma.Decimal(0);
  for (const s of posSales) {
    if (s.paymentMethod === 'cash') posCash = posCash.add(s.totalPkr);
    else posDigital = posDigital.add(s.totalPkr);
  }

  return {
    date: key,
    drivers,
    pos: { cashPkr: posCash.toString(), digitalPkr: posDigital.toString(), count: posSales.length },
  };
}

// FI03: mark a driver's day reconciled once cash is physically counted.
export async function markDriverReconciled(
  actor: Actor,
  driverId: string,
  dateStr?: string
): Promise<{ reconciled: number }> {
  const { gte, lt } = dayRange(dateStr);
  const res = await prisma.$transaction(async (tx) => {
    // Reconciliation means the physically-counted CASH/DIGITAL matched — it must
    // NOT touch credit rows. A credit payment is a deferral that still anchors
    // the retailer's outstanding ageing (RT05/FI05); flipping it to reconciled
    // would silently zero the overdue report.
    const r = await tx.payment.updateMany({
      where: {
        driverId,
        collectedAt: { gte, lt },
        reconciled: false,
        method: { not: PaymentMethod.credit },
      },
      data: { reconciled: true, reconciledAt: new Date(), reconciledBy: actor.id },
    });
    await recordAudit(
      {
        actor,
        action: 'reconcile',
        entityType: 'payment',
        entityId: driverId,
        newValue: { driverId, count: r.count },
      },
      tx
    );
    return r;
  });
  return { reconciled: res.count };
}

// SRS RT05/FI05: outstanding balances with ageing buckets. A retailer's
// balance ages from its oldest unreconciled credit payment.
export async function outstandingAgeing() {
  const retailers = await prisma.retailer.findMany({
    where: { isDeleted: false, outstandingBalance: { gt: 0 } },
    select: {
      id: true,
      shopName: true,
      outstandingBalance: true,
      overdueThresholdDays: true,
    },
    orderBy: { outstandingBalance: 'desc' },
  });

  const now = Date.now();
  const settings = await prisma.companySettings.findFirst({
    select: { alertBalanceThreshold: true },
  });

  // Oldest unreconciled credit payment per retailer, in ONE query instead of
  // one findFirst per retailer (was an N+1 — this runs on 3 hot paths:
  // superAdmin dashboard, finance dashboard, and the hourly alert cron).
  const oldestRows = await prisma.payment.groupBy({
    by: ['retailerId'],
    where: {
      retailerId: { in: retailers.map((r) => r.id) },
      method: PaymentMethod.credit,
      reconciled: false,
    },
    _min: { collectedAt: true },
  });
  const oldestByRetailer = new Map(
    oldestRows.map((o) => [o.retailerId, o._min.collectedAt])
  );

  const rows = [];
  let totalCurrent = 0;
  let total30 = 0;
  let total60 = 0;
  let total90 = 0;
  for (const r of retailers) {
    const oldest = oldestByRetailer.get(r.id) ?? null;
    const ageDays = oldest
      ? Math.floor((now - oldest.getTime()) / 86_400_000)
      : 0;
    const amount = Number(r.outstandingBalance);
    const bucket = ageDays >= 90 ? '90+' : ageDays >= 60 ? '60' : ageDays >= 30 ? '30' : 'current';
    if (bucket === '90+') total90 += amount;
    else if (bucket === '60') total60 += amount;
    else if (bucket === '30') total30 += amount;
    else totalCurrent += amount;
    rows.push({
      retailerId: r.id,
      shopName: r.shopName,
      outstandingPkr: r.outstandingBalance.toString(),
      ageDays,
      bucket,
      overdue: ageDays >= (r.overdueThresholdDays ?? 30),
    });
  }
  const grandTotal = totalCurrent + total30 + total60 + total90;
  return {
    rows,
    buckets: { current: totalCurrent, d30: total30, d60: total60, d90plus: total90 },
    grandTotalPkr: grandTotal,
    alertThresholdPkr: Number(settings?.alertBalanceThreshold ?? 0),
  };
}

// FI06: record a credit repayment. payments.orderId is NOT NULL so a
// standalone repayment can't live there without a schema change; we adjust
// the retailer balance immediately and write an immutable audit entry as
// the ledger record (documented limitation — a dedicated repayments ledger
// is a later refinement).
export async function recordCreditPayment(
  actor: Actor,
  retailerId: string,
  amountPkr: number | string
): Promise<{ outstandingBalance: string }> {
  const amount = new Prisma.Decimal(amountPkr);
  if (amount.lte(0)) throw new HttpError(400, 'INVALID_AMOUNT', 'Amount must be positive');
  return prisma.$transaction(async (tx) => {
    const r = await tx.retailer.findUnique({ where: { id: retailerId } });
    if (!r || r.isDeleted) throw new HttpError(404, 'RETAILER_NOT_FOUND', 'Retailer not found');
    const newBalance = Prisma.Decimal.max(new Prisma.Decimal(0), r.outstandingBalance.sub(amount));
    const updated = await tx.retailer.update({
      where: { id: retailerId },
      data: { outstandingBalance: newBalance },
    });
    await recordAudit(
      {
        actor,
        action: 'credit_payment',
        entityType: 'retailer',
        entityId: retailerId,
        oldValue: { outstandingBalance: r.outstandingBalance.toString() },
        newValue: { outstandingBalance: newBalance.toString(), paid: amount.toString() },
      },
      tx
    );
    return { outstandingBalance: updated.outstandingBalance.toString() };
  });
}

// SRS RT05/FI05: a single retailer's payment history for the Outstanding
// drawer. Two sources merged chronologically: driver-collected per-order
// Payment rows, and admin credit-repayments (which only decrement the balance
// + write an audit entry — Payment.orderId is required, so a credit repayment
// is not a Payment row). Finance Manager / Super Admin only (route-gated).
export async function retailerPaymentHistory(retailerId: string) {
  const retailer = await prisma.retailer.findUnique({
    where: { id: retailerId },
    select: { id: true, shopName: true, outstandingBalance: true, isDeleted: true },
  });
  if (!retailer || retailer.isDeleted) {
    throw new HttpError(404, 'RETAILER_NOT_FOUND', 'Retailer not found');
  }

  const [collections, creditEntries] = await Promise.all([
    prisma.payment.findMany({
      where: { retailerId },
      orderBy: { collectedAt: 'desc' },
      include: {
        order: { select: { orderNumber: true } },
        driver: { select: { name: true } },
      },
    }),
    prisma.auditLog.findMany({
      where: { entityType: 'retailer', entityId: retailerId, action: 'credit_payment' },
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { name: true } } },
    }),
  ]);

  type Row = {
    id: string;
    kind: 'collection' | 'credit_repayment';
    date: string;
    amountPkr: string;
    method: string;
    referenceNo: string | null;
    orderNumber: string | null;
    byName: string;
    reconciled: boolean | null;
  };

  const payments: Row[] = [
    ...collections.map((p): Row => ({
      id: p.id,
      kind: 'collection',
      date: p.collectedAt.toISOString(),
      amountPkr: p.amountPkr.toString(),
      method: p.method,
      referenceNo: p.referenceNo,
      orderNumber: p.order.orderNumber,
      byName: p.driver.name,
      reconciled: p.reconciled,
    })),
    ...creditEntries.map((e): Row => ({
      id: e.id,
      kind: 'credit_repayment',
      date: e.createdAt.toISOString(),
      amountPkr: String((e.newValue as { paid?: string } | null)?.paid ?? '0'),
      method: 'credit',
      referenceNo: null,
      orderNumber: null,
      byName: e.actor.name,
      reconciled: null,
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));

  const totalPaidPkr = payments.reduce((s, p) => s + Number(p.amountPkr), 0);
  return {
    retailer: {
      id: retailer.id,
      shopName: retailer.shopName,
      outstandingPkr: retailer.outstandingBalance.toString(),
    },
    payments,
    totalPaidPkr: Math.round((totalPaidPkr + Number.EPSILON) * 100) / 100,
  };
}
