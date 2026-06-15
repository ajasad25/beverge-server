import { HealthState, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

// SRS §10.6 retailer health engine. Recalculated nightly (not on read).
//   active   — ordered at least once in the last 14 days
//   growing  — order frequency OR value up > 20% vs the previous
//              equivalent (30-day) period
//   at_risk  — no order in 15–30 days, OR the last 3 orders declined in value
//   inactive — no order in 31+ days (or never)
// Precedence applied: inactive → (15–30d gap) at_risk → growing → declining
// at_risk → active.
const DAY = 86_400_000;

function classify(
  orderDates: Date[],
  valuesNewestFirst: { date: Date; value: number }[],
  now: number
): HealthState {
  if (orderDates.length === 0) return HealthState.inactive;
  const lastMs = orderDates[0]!.getTime();
  const daysSince = Math.floor((now - lastMs) / DAY);

  if (daysSince >= 31) return HealthState.inactive;
  if (daysSince >= 15) return HealthState.at_risk;

  // Within the active window. Compare this 30d vs the previous 30d.
  const cur = valuesNewestFirst.filter((o) => now - o.date.getTime() < 30 * DAY);
  const prev = valuesNewestFirst.filter(
    (o) => now - o.date.getTime() >= 30 * DAY && now - o.date.getTime() < 60 * DAY
  );
  const sum = (a: { value: number }[]) => a.reduce((s, x) => s + x.value, 0);
  const curVal = sum(cur);
  const prevVal = sum(prev);
  const freqUp = prev.length > 0 && cur.length > prev.length * 1.2;
  const valUp = prevVal > 0 && curVal > prevVal * 1.2;
  if (freqUp || valUp) return HealthState.growing;

  // Last 3 orders strictly declining in value → at risk.
  if (valuesNewestFirst.length >= 3) {
    const [a, b, c] = valuesNewestFirst;
    if (a!.value < b!.value && b!.value < c!.value) return HealthState.at_risk;
  }
  return HealthState.active;
}

export async function recomputeRetailerHealth(): Promise<{
  scanned: number;
  changed: number;
}> {
  const now = Date.now();
  const retailers = await prisma.retailer.findMany({
    where: { isDeleted: false },
    select: { id: true, healthState: true },
  });

  // All non-cancelled orders in ONE query (newest first), grouped per retailer
  // in memory — replaces one findMany per retailer (was an N+1 nightly cron).
  // Only the 3 small columns classify() needs are selected. We keep the newest
  // 60 per retailer, exactly as the previous per-retailer `take: 60` did.
  const allOrders = await prisma.order.findMany({
    where: { status: { not: 'cancelled' } },
    select: { retailerId: true, orderDate: true, totalValuePkr: true },
    orderBy: { orderDate: 'desc' },
  });
  const ordersByRetailer = new Map<string, { date: Date; value: number }[]>();
  for (const o of allOrders) {
    const list = ordersByRetailer.get(o.retailerId);
    if (list) {
      if (list.length < 60) list.push({ date: o.orderDate, value: Number(o.totalValuePkr) });
    } else {
      ordersByRetailer.set(o.retailerId, [
        { date: o.orderDate, value: Number(o.totalValuePkr) },
      ]);
    }
  }

  // Collect changes, then write them grouped by target state: at most 4
  // updateMany calls instead of one update per changed retailer.
  const toState = new Map<HealthState, string[]>();
  for (const r of retailers) {
    const hist = ordersByRetailer.get(r.id) ?? [];
    const next = classify(
      hist.map((o) => o.date),
      hist,
      now
    );
    if (next !== r.healthState) {
      const ids = toState.get(next);
      if (ids) ids.push(r.id);
      else toState.set(next, [r.id]);
    }
  }

  let changed = 0;
  for (const [state, ids] of toState) {
    const res = await prisma.retailer.updateMany({
      where: { id: { in: ids } },
      data: { healthState: state },
    });
    changed += res.count;
  }
  return { scanned: retailers.length, changed };
}

// Distribution for the Sales Manager dashboard donut (§10.2).
export async function healthDistribution(): Promise<Record<HealthState, number>> {
  const rows = await prisma.retailer.groupBy({
    by: ['healthState'],
    where: { isDeleted: false },
    _count: { _all: true },
  });
  const out: Record<HealthState, number> = {
    active: 0,
    growing: 0,
    at_risk: 0,
    inactive: 0,
  };
  for (const x of rows) out[x.healthState] = x._count._all;
  return out;
}

// Re-export Prisma for callers that need the enum without a second import.
export { HealthState, Prisma };
