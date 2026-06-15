import { prisma } from '../lib/prisma';

// Full offline snapshot for a salesman (SRS §5.1). One bundled payload so the
// morning download is a single round-trip (SRS §15.1: < 15s on 3G). Read-only
// — no audit. Everything is scoped to the authenticated salesman server-side;
// the client cannot widen scope (SRS §15.2 row-level security).
export async function buildSalesmanSnapshot(salesmanId: string) {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const [zones, retailers, products, targets, orders, settings] = await Promise.all([
    // Active zones — the salesman needs the zone list to register a new
    // retailer offline (SRS SM12). Small table, whole list is fine.
    prisma.zone.findMany({
      where: { isActive: true },
      select: { id: true, name: true, city: true },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
    }),
    prisma.retailer.findMany({
      where: { primarySalesmanId: salesmanId, isDeleted: false },
      include: {
        specialPrices: {
          select: { productId: true, specialPrice: true },
        },
      },
      orderBy: { shopName: 'asc' },
    }),
    prisma.product.findMany({
      where: { isDeleted: false, isActive: true },
      include: {
        warehouseStock: { select: { quantityOnHand: true, lowStockThreshold: true } },
      },
      orderBy: { name: 'asc' },
    }),
    prisma.salesmanTarget.findMany({
      where: { salesmanId },
      orderBy: [{ periodType: 'asc' }, { effectiveFrom: 'desc' }],
    }),
    // Recent order history for offline reference. Bounded: a salesman with a
    // busy 30 days could otherwise pull hundreds of orders + all their items
    // into the morning snapshot, blowing the SRS §15.1 "<15s on 3G" budget.
    // 200 newest covers the offline duplicate-order check and history view.
    prisma.order.findMany({
      where: { salesmanId, orderDate: { gte: since } },
      include: { items: true },
      orderBy: { orderDate: 'desc' },
      take: 200,
    }),
    prisma.companySettings.findFirst({
      select: { name: true, currency: true, city: true, logoUrl: true },
    }),
  ]);

  // The salesman's own discount limits — needed so the approval gate (SRS
  // D13/SM27: within limit → PENDING, over → PENDING_APPROVAL) can be
  // evaluated fully offline. Server still re-checks on submit (§15.2).
  const me = await prisma.user.findUnique({
    where: { id: salesmanId },
    select: { name: true, maxDiscountPct: true, maxDiscountPkr: true },
  });

  return {
    // Server clock — the client stamps the snapshot with this and expires it
    // at the next local midnight (SRS SM06).
    serverTime: new Date().toISOString(),
    salesman: {
      name: me?.name ?? '',
      maxDiscountPct: me?.maxDiscountPct?.toString() ?? null,
      maxDiscountPkr: me?.maxDiscountPkr?.toString() ?? null,
    },
    zones,
    retailers,
    products,
    targets,
    orders,
    settings,
  };
}
