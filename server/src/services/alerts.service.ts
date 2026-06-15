import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { businessDateBounds, businessDayBounds, startOfBusinessDay } from '../lib/businessDay';

// SRS §9.6 in-app alert engine. Recompute is idempotent per day: an alert
// of the same type+message already raised (and unresolved) today is not
// duplicated, so the sweep can run hourly without spamming the badge.
async function raise(alertType: string, message: string): Promise<boolean> {
  const existing = await prisma.systemAlert.findFirst({
    where: { alertType, message, resolved: false, triggeredAt: { gte: startOfBusinessDay() } },
    select: { id: true },
  });
  if (existing) return false;
  await prisma.systemAlert.create({ data: { alertType, message } });
  return true;
}

export async function recomputeAlerts(): Promise<{ raised: number; byType: Record<string, number> }> {
  // Instant window for timestamptz columns (visits are logged at a moment);
  // date-only window for @db.Date columns (deliveryDate, shiftDate).
  const { gte: dayStart, lt: dayEnd } = businessDayBounds();
  const { gte: dateStart, lt: dateEnd } = businessDateBounds();

  const settings = await prisma.companySettings.findFirst();
  const byType: Record<string, number> = {};
  const bump = async (type: string, msg: string) => {
    if (await raise(type, msg)) byType[type] = (byType[type] ?? 0) + 1;
  };

  // 1. Salesman idle — active salesman with 0 visits logged today.
  // One groupBy for "who visited today" instead of a count per salesman.
  const salesmen = await prisma.user.findMany({
    where: { role: 'salesman', isActive: true, isDeleted: false },
    select: { id: true, name: true },
  });
  const visitedToday = new Set(
    (
      await prisma.visit.groupBy({
        by: ['salesmanId'],
        where: { visitedAt: { gte: dayStart, lt: dayEnd } },
      })
    ).map((v) => v.salesmanId)
  );
  for (const s of salesmen) {
    if (!visitedToday.has(s.id))
      await bump('salesman_idle', `Salesman ${s.name} has logged no visits today`);
  }

  // 2. Zone failure spike — > threshold failed deliveries in a zone today.
  const zoneFailThreshold = settings?.zoneFailureThreshold ?? 3;
  const failedByZone = await prisma.order.groupBy({
    by: ['zoneId'],
    where: { status: OrderStatus.failed, deliveryDate: { gte: dateStart, lt: dateEnd } },
    _count: { _all: true },
  });
  const spikeZoneIds = failedByZone
    .filter((z) => z._count._all > zoneFailThreshold)
    .map((z) => z.zoneId);
  if (spikeZoneIds.length > 0) {
    const zoneNames = new Map(
      (
        await prisma.zone.findMany({
          where: { id: { in: spikeZoneIds } },
          select: { id: true, name: true },
        })
      ).map((z) => [z.id, z.name])
    );
    for (const z of failedByZone) {
      if (z._count._all > zoneFailThreshold) {
        await bump(
          'zone_failure_spike',
          `Zone ${zoneNames.get(z.zoneId) ?? z.zoneId} has ${z._count._all} failed deliveries today`
        );
      }
    }
  }

  // 3. Balance threshold — total outstanding over the configured PKR cap.
  const cap = settings?.alertBalanceThreshold ?? new Prisma.Decimal(0);
  if (cap.gt(0)) {
    const agg = await prisma.retailer.aggregate({
      where: { isDeleted: false },
      _sum: { outstandingBalance: true },
    });
    const total = agg._sum.outstandingBalance ?? new Prisma.Decimal(0);
    if (total.gt(cap)) {
      await bump(
        'balance_threshold',
        `Total outstanding ${total} exceeds the alert threshold ${cap}`
      );
    }
  }

  // 4. Low stock — any active SKU at/below its threshold.
  const lowStock = await prisma.warehouseStock.findMany({
    where: { product: { isActive: true, isDeleted: false } },
    include: { product: { select: { name: true } } },
  });
  for (const ws of lowStock) {
    if (ws.quantityOnHand <= ws.lowStockThreshold) {
      await bump(
        'low_stock',
        `${ws.product.name} is low: ${ws.quantityOnHand} on hand (threshold ${ws.lowStockThreshold})`
      );
    }
  }

  // 5. Discount approval pending.
  const pendingApprovals = await prisma.discountApproval.count({ where: { status: 'pending' } });
  if (pendingApprovals > 0) {
    await bump('discount_approval_pending', `${pendingApprovals} discount approval(s) waiting`);
  }

  // 6. EOD not submitted — driver loaded today but logged no returns.
  // Two groupBys (total rows / unreturned rows per driver) instead of two
  // counts + a findUnique per loaded driver.
  const totalByDriver = await prisma.vehicleStock.groupBy({
    by: ['driverId'],
    where: { shiftDate: { gte: dateStart, lt: dateEnd } },
    _count: { _all: true },
  });
  const pendingByDriver = new Map(
    (
      await prisma.vehicleStock.groupBy({
        by: ['driverId'],
        where: { shiftDate: { gte: dateStart, lt: dateEnd }, qtyReturnedLogged: null },
        _count: { _all: true },
      })
    ).map((d) => [d.driverId, d._count._all])
  );
  const eodDriverIds = totalByDriver
    .filter((d) => d._count._all > 0 && (pendingByDriver.get(d.driverId) ?? 0) === d._count._all)
    .map((d) => d.driverId);
  if (eodDriverIds.length > 0) {
    const driverNames = new Map(
      (
        await prisma.user.findMany({
          where: { id: { in: eodDriverIds } },
          select: { id: true, name: true },
        })
      ).map((u) => [u.id, u.name])
    );
    for (const id of eodDriverIds) {
      await bump('eod_not_submitted', `Driver ${driverNames.get(id) ?? id} has not submitted EOD`);
    }
  }

  // 7. Stock discrepancy — vehicle_stock flagged at verification.
  const discrepancies = await prisma.vehicleStock.findMany({
    where: { discrepancyFlag: true, shiftDate: { gte: dateStart, lt: dateEnd } },
    select: { id: true, driverId: true },
  });
  for (const v of discrepancies) {
    await bump('stock_discrepancy', `Stock discrepancy on vehicle_stock ${v.id}`);
  }

  const raised = Object.values(byType).reduce((a, b) => a + b, 0);
  return { raised, byType };
}

export async function listAlerts(opts: { resolved?: boolean } = {}) {
  return prisma.systemAlert.findMany({
    where: opts.resolved === undefined ? {} : { resolved: opts.resolved },
    orderBy: { triggeredAt: 'desc' },
    take: 200,
  });
}

export async function markSeen(alertId: string, userId: string): Promise<void> {
  const alert = await prisma.systemAlert.findUnique({ where: { id: alertId } });
  if (!alert) return;
  const seen = new Set(Array.isArray(alert.seenBy) ? (alert.seenBy as string[]) : []);
  seen.add(userId);
  await prisma.systemAlert.update({
    where: { id: alertId },
    data: { seenBy: [...seen] as Prisma.InputJsonValue },
  });
}

export async function resolveAlert(alertId: string): Promise<void> {
  await prisma.systemAlert.update({ where: { id: alertId }, data: { resolved: true } });
}
