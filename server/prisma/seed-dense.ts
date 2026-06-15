/* eslint-disable no-console */
// Dense, realistic dataset for end-to-end testing of analytics, finance,
// inventory, POS and the order lifecycle. Destructive: wipes generated
// business data and regenerates ~45 days of history. Keeps company_settings
// and re-establishes the three canonical login users.
//
//   npm run prisma:seed:dense        (from server/)
//
import bcrypt from 'bcrypt';
import {
  PrismaClient,
  Role,
  Language,
  UnitType,
  RetailerStatus,
  HealthState,
  VisitType,
  OrderStatus,
  DiscountType,
  DiscountApprovalStatus,
  DeliveryStatus,
  PaymentMethod,
  POSPaymentMethod,
  PeriodType,
  StockMovementType,
  Prisma,
} from '@prisma/client';

const prisma = new PrismaClient();

// ── deterministic RNG so re-runs are reproducible ───────────────────────
let _s = 1234567;
const rnd = (): number => {
  _s = (_s * 1103515245 + 12345) & 0x7fffffff;
  return _s / 0x7fffffff;
};
const ri = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const chance = (p: number): boolean => rnd() < p;

// Operator-timezone "day" as a UTC-midnight Date (matches lib/dates.ts).
const DAY_MS = 86_400_000;
function dayUTC(offsetDaysAgo: number): Date {
  const now = new Date();
  const t = new Date(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  );
  return new Date(t.getTime() - offsetDaysAgo * DAY_MS);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}
const D = (n: number): Prisma.Decimal => new Prisma.Decimal(n);

// Three-layer pricing (mirror of server/src/lib/pricing.ts).
function effective(base: number, special: number | null, dType: DiscountType, dVal: number): number {
  const disc = dType === DiscountType.pct ? base * (dVal / 100) : dType === DiscountType.pkr ? dVal : 0;
  const floor = special ?? base;
  return Math.max(floor, base - disc);
}

const HISTORY_DAYS = 45;

async function main(): Promise<void> {
  console.log('Wiping generated business data…');
  // FK-safe delete order.
  await prisma.posSaleItem.deleteMany();
  await prisma.posSale.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.deliveryProof.deleteMany();
  await prisma.discountApproval.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.order.deleteMany();
  await prisma.stockMovement.deleteMany();
  await prisma.vehicleStock.deleteMany();
  await prisma.grnRecord.deleteMany();
  await prisma.retailerPrice.deleteMany();
  await prisma.salesmanTarget.deleteMany();
  await prisma.warehouseStock.deleteMany();
  await prisma.retailer.deleteMany();
  await prisma.product.deleteMany();
  await prisma.systemAlert.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.userZone.deleteMany();

  // ── Company settings (singleton) ──────────────────────────────────────
  const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
  await prisma.companySettings.upsert({
    where: { id: COMPANY_ID },
    update: {},
    create: {
      id: COMPANY_ID,
      name: 'Acme Beverages',
      city: 'Lahore',
      currency: 'PKR',
      address: 'Industrial Estate, Lahore',
      ntn: '1234567-8',
      contactPhone: '042-35000000',
      contactEmail: 'ops@acmebeverages.pk',
    },
  });

  // ── Users ─────────────────────────────────────────────────────────────
  console.log('Users…');
  const hash = (pin: string): Promise<string> => bcrypt.hash(pin, 12);
  type U = { id: string };
  async function user(
    phone: string,
    name: string,
    role: Role,
    pin: string,
    extra: Partial<Prisma.UserUncheckedCreateInput> = {}
  ): Promise<U> {
    const pinHash = await hash(pin);
    return prisma.user.upsert({
      where: { phone },
      update: { name, role, pinHash, isActive: true, isDeleted: false, ...extra },
      create: { phone, name, role, pinHash, language: Language.en, ...extra },
      select: { id: true },
    });
  }
  const superAdmin = await user('03001234567', 'Super Admin', Role.super_admin, '000000');
  const salesMgr = await user('03001000001', 'Sara Sales Mgr', Role.sales_manager, '100001');
  const invMgr = await user('03001000002', 'Imran Inventory Mgr', Role.inventory_manager, '100002');
  const finMgr = await user('03001000003', 'Faisal Finance Mgr', Role.finance_manager, '100003');
  const cashier = await user('03001000004', 'Kamran Cashier', Role.pos_cashier, '100004', {
    maxDiscountPct: D(5),
    maxDiscountPkr: D(300),
  });

  const salesmen: U[] = [];
  const salesmanInfo = [
    ['03001111111', 'Ahmed Ali', '111111'],
    ['03001111112', 'Bilal Salesman', '111112'],
    ['03001111113', 'Usman Tariq', '111113'],
    ['03001111114', 'Hamza Iqbal', '111114'],
    ['03001111115', 'Zain Abbas', '111115'],
  ] as const;
  for (const [ph, nm, pin] of salesmanInfo) {
    salesmen.push(
      await user(ph, nm, Role.salesman, pin, {
        maxDiscountPct: D(pick([5, 8, 10])),
        maxDiscountPkr: D(pick([300, 500, 800])),
      })
    );
  }
  const drivers: U[] = [];
  const driverInfo = [
    ['03002222222', 'Bilal Khan', '222222'],
    ['03002222223', 'Naveed Driver', '222223'],
    ['03002222224', 'Rashid Driver', '222224'],
  ] as const;
  for (const [ph, nm, pin] of driverInfo) drivers.push(await user(ph, nm, Role.driver, pin));

  // ── Zones ─────────────────────────────────────────────────────────────
  console.log('Zones…');
  const zoneNames = ['Gulberg', 'Model Town', 'DHA', 'Johar Town', 'Cantt', 'Shadman'];
  const zones: { id: string }[] = [];
  for (const name of zoneNames) {
    zones.push(
      await prisma.zone.upsert({
        where: { name_city: { name, city: 'Lahore' } },
        update: { isActive: true },
        create: { name, city: 'Lahore', description: `${name} commercial area` },
        select: { id: true },
      })
    );
  }
  // Assign salesmen + drivers to zones.
  let zi = 0;
  for (const s of salesmen) {
    await prisma.userZone.create({ data: { userId: s.id, zoneId: zones[zi % zones.length]!.id } });
    await prisma.userZone.create({ data: { userId: s.id, zoneId: zones[(zi + 1) % zones.length]!.id } });
    zi++;
  }
  for (const d of drivers) for (const z of zones) await prisma.userZone.create({ data: { userId: d.id, zoneId: z.id } });

  // ── Products (30 SKUs) ────────────────────────────────────────────────
  console.log('Products…');
  const catalog: [string, string, string, UnitType, number][] = [
    ['COLA-250', 'Cola 250ml bottle', 'Carbonated', UnitType.bottle, 45],
    ['COLA-500', 'Cola 500ml bottle', 'Carbonated', UnitType.bottle, 80],
    ['COLA-1L', 'Cola 1L bottle', 'Carbonated', UnitType.bottle, 130],
    ['COLA-CR', 'Cola 250ml crate (24)', 'Carbonated', UnitType.crate, 1000],
    ['LEMON-250', 'Lemon Up 250ml', 'Carbonated', UnitType.bottle, 45],
    ['LEMON-500', 'Lemon Up 500ml', 'Carbonated', UnitType.bottle, 80],
    ['ORANGE-250', 'Orange Fizz 250ml', 'Carbonated', UnitType.bottle, 45],
    ['ORANGE-CR', 'Orange Fizz crate (24)', 'Carbonated', UnitType.crate, 1000],
    ['MANGO-250', 'Mango Juice 250ml', 'Juice', UnitType.bottle, 60],
    ['MANGO-1L', 'Mango Juice 1L', 'Juice', UnitType.bottle, 200],
    ['APPLE-250', 'Apple Juice 250ml', 'Juice', UnitType.bottle, 60],
    ['APPLE-1L', 'Apple Juice 1L', 'Juice', UnitType.bottle, 200],
    ['MIX-CTN', 'Mixed Juice carton (12)', 'Juice', UnitType.carton, 700],
    ['WATER-500', 'Mineral Water 500ml', 'Water', UnitType.bottle, 30],
    ['WATER-1.5', 'Mineral Water 1.5L', 'Water', UnitType.bottle, 70],
    ['WATER-CR', 'Water 500ml crate (12)', 'Water', UnitType.crate, 330],
    ['SODA-250', 'Club Soda 250ml', 'Carbonated', UnitType.bottle, 40],
    ['TONIC-250', 'Tonic Water 250ml', 'Carbonated', UnitType.bottle, 50],
    ['ENERGY-250', 'Energy Drink 250ml', 'Energy', UnitType.bottle, 120],
    ['ENERGY-CTN', 'Energy Drink carton (24)', 'Energy', UnitType.carton, 2700],
    ['ICED-TEA', 'Iced Tea 350ml', 'Tea', UnitType.bottle, 70],
    ['GREEN-TEA', 'Green Iced Tea 350ml', 'Tea', UnitType.bottle, 75],
    ['MILK-250', 'Flavoured Milk 250ml', 'Dairy', UnitType.bottle, 65],
    ['MILK-1L', 'Flavoured Milk 1L', 'Dairy', UnitType.bottle, 230],
    ['YOG-200', 'Yogurt Drink 200ml', 'Dairy', UnitType.bottle, 55],
    ['LASSI-250', 'Sweet Lassi 250ml', 'Dairy', UnitType.bottle, 60],
    ['COFFEE-240', 'Cold Coffee 240ml', 'Dairy', UnitType.bottle, 110],
    ['SPARK-330', 'Sparkling Water 330ml', 'Water', UnitType.bottle, 90],
    ['GINGER-250', 'Ginger Ale 250ml', 'Carbonated', UnitType.bottle, 55],
    ['POME-250', 'Pomegranate Juice 250ml', 'Juice', UnitType.bottle, 85],
  ];
  const products: { id: string; base: number; unit: UnitType }[] = [];
  for (const [sku, name, category, unitType, basePrice] of catalog) {
    const p = await prisma.product.create({
      data: { sku, name, category, unitType, basePrice: D(basePrice) },
      select: { id: true },
    });
    products.push({ id: p.id, base: basePrice, unit: unitType });
    const onHand = ri(60, 1200);
    await prisma.warehouseStock.create({
      data: {
        productId: p.id,
        quantityOnHand: onHand,
        lowStockThreshold: chance(0.25) ? Math.floor(onHand * 1.2) : 50, // some flagged low
      },
    });
    // Opening GRN
    await prisma.grnRecord.create({
      data: {
        productId: p.id,
        qtyReceived: onHand,
        unitType,
        supplierRef: `GRN-OPEN-${sku}`,
        receivedBy: invMgr.id,
        receivedAt: dayUTC(HISTORY_DAYS),
      },
    });
    await prisma.stockMovement.create({
      data: {
        productId: p.id,
        movementType: StockMovementType.grn,
        qty: onHand,
        unitType,
        actorId: invMgr.id,
        note: 'Opening stock',
        createdAt: dayUTC(HISTORY_DAYS),
      },
    });
  }

  // ── Retailers (40) ────────────────────────────────────────────────────
  console.log('Retailers…');
  const shopWords = ['Sharif', 'Al-Madina', 'Bismillah', 'New', 'City', 'Star', 'Friends', 'National', 'Capital', 'Royal', 'Lucky', 'Modern', 'Galaxy', 'Sunrise', 'Green', 'Metro', 'Prime', 'Elite', 'Corner', 'Express'];
  const shopTypes = ['Store', 'Mart', 'Traders', 'General Store', 'Karyana', 'Cash & Carry', 'Super Store'];
  const health: HealthState[] = [HealthState.active, HealthState.growing, HealthState.at_risk, HealthState.inactive];
  const retailers: { id: string; zoneId: string; salesmanId: string; outstanding: number }[] = [];
  for (let i = 0; i < 40; i++) {
    const z = zones[i % zones.length]!;
    const s = salesmen[i % salesmen.length]!;
    const credit = pick([0, 20000, 50000, 100000, 150000]);
    const r = await prisma.retailer.create({
      data: {
        shopName: `${pick(shopWords)} ${pick(shopTypes)}`,
        ownerName: `${pick(['Mohammad', 'Ali', 'Hassan', 'Bilal', 'Tariq', 'Saeed', 'Asif'])} ${pick(['Khan', 'Ahmed', 'Malik', 'Butt', 'Sheikh'])}`,
        phone: `0300${ri(1000000, 9999999)}`,
        gpsLat: D(31.45 + rnd() * 0.18),
        gpsLng: D(74.25 + rnd() * 0.22),
        zoneId: z.id,
        primarySalesmanId: s.id,
        creditLimit: D(credit),
        creditLimitApproved: credit > 0,
        creditLimitApprovedBy: credit > 0 ? salesMgr.id : null,
        healthState: pick(health),
        status: chance(0.9) ? RetailerStatus.active : pick([RetailerStatus.suspended, RetailerStatus.inactive]),
        registeredAt: dayUTC(ri(HISTORY_DAYS, HISTORY_DAYS + 120)),
      },
      select: { id: true },
    });
    retailers.push({ id: r.id, zoneId: z.id, salesmanId: s.id, outstanding: 0 });
    // Special prices on ~6 products for this retailer (exercise pricing floor).
    const specialProducts = [...products].sort(() => rnd() - 0.5).slice(0, 6);
    for (const p of specialProducts) {
      await prisma.retailerPrice.create({
        data: {
          retailerId: r.id,
          productId: p.id,
          specialPrice: D(Math.round(p.base * (0.85 + rnd() * 0.1))),
          setBy: salesMgr.id,
        },
      });
    }
  }

  // ── Salesman targets ──────────────────────────────────────────────────
  for (const s of salesmen) {
    for (const period of [PeriodType.monthly, PeriodType.weekly] as const) {
      await prisma.salesmanTarget.create({
        data: {
          salesmanId: s.id,
          periodType: period,
          targetOrderValuePkr: D(period === PeriodType.monthly ? 800000 : 200000),
          targetVisitCount: period === PeriodType.monthly ? 200 : 50,
          effectiveFrom: dayUTC(HISTORY_DAYS),
        },
      });
    }
  }

  // ── Orders + lifecycle across HISTORY_DAYS ────────────────────────────
  console.log(`Orders / deliveries / payments over ${HISTORY_DAYS} days…`);
  const specialByRetailer = new Map<string, Map<string, number>>();
  for (const rp of await prisma.retailerPrice.findMany({ select: { retailerId: true, productId: true, specialPrice: true } })) {
    if (!specialByRetailer.has(rp.retailerId)) specialByRetailer.set(rp.retailerId, new Map());
    specialByRetailer.get(rp.retailerId)!.set(rp.productId, Number(rp.specialPrice));
  }

  let orderCount = 0;
  let posCount = 0;
  // Per-year order-number sequence, mirroring the app's nextOrderNumber()
  // (ORD-YYYY-NNNNNN). The day loop runs oldest→newest so seq order matches
  // created_at order, exactly like the production allocator.
  const orderSeqByYear: Record<number, number> = {};
  for (let dAgo = HISTORY_DAYS; dAgo >= 0; dAgo--) {
    const orderDate = dayUTC(dAgo);
    const deliveryDate = addDays(orderDate, 1);
    // Each day a random ~35% of retailers get an order from their salesman.
    const todays = retailers.filter(() => chance(0.35));
    for (const r of todays) {
      const driver = pick(drivers);
      // Status by recency: old days mostly delivered; last 2 days open.
      let status: OrderStatus;
      if (dAgo <= 1) status = pick([OrderStatus.pending, OrderStatus.pending, OrderStatus.assigned, OrderStatus.pending_approval]);
      else if (dAgo === 2) status = pick([OrderStatus.assigned, OrderStatus.delivered, OrderStatus.partial]);
      else status = pick([OrderStatus.delivered, OrderStatus.delivered, OrderStatus.delivered, OrderStatus.partial, OrderStatus.failed, OrderStatus.cancelled]);

      const nLines = ri(1, 4);
      const chosen = [...products].sort(() => rnd() - 0.5).slice(0, nLines);
      const specials = specialByRetailer.get(r.id);
      let total = 0;
      const itemsData: Prisma.OrderItemCreateManyOrderInput[] = [];
      let needsApproval = false;
      for (const p of chosen) {
        const qty = ri(2, 40);
        const dType = chance(0.5) ? DiscountType.none : pick([DiscountType.pct, DiscountType.pkr]);
        const dVal = dType === DiscountType.pct ? ri(2, 15) : dType === DiscountType.pkr ? ri(2, 12) : 0;
        if (dType === DiscountType.pct && dVal > 10) needsApproval = true;
        const sp = specials?.get(p.id) ?? null;
        const eff = effective(p.base, sp, dType, dVal);
        total += eff * qty;
        itemsData.push({
          productId: p.id,
          unitType: p.unit,
          qtyOrdered: qty,
          qtyDelivered:
            status === OrderStatus.delivered ? qty : status === OrderStatus.partial ? Math.floor(qty * 0.6) : status === OrderStatus.failed ? 0 : null,
          unitPrice: D(p.base),
          specialPriceApplied: sp != null ? D(sp) : null,
          discountType: dType,
          discountValue: D(dVal),
          effectiveUnitPrice: D(eff),
        });
      }
      const isApprovalState = status === OrderStatus.pending_approval || (needsApproval && status === OrderStatus.pending);
      const oYear = orderDate.getFullYear();
      const oSeq = (orderSeqByYear[oYear] = (orderSeqByYear[oYear] ?? 0) + 1);
      const order = await prisma.order.create({
        data: {
          orderNumber: `ORD-${oYear}-${String(oSeq).padStart(6, '0')}`,
          retailerId: r.id,
          salesmanId: r.salesmanId,
          zoneId: r.zoneId,
          driverId: status === OrderStatus.assigned || status === OrderStatus.delivered || status === OrderStatus.partial || status === OrderStatus.failed ? driver.id : null,
          status,
          orderDate,
          deliveryDate,
          note: chance(0.15) ? 'Deliver before noon' : null,
          totalValuePkr: D(Math.round(total)),
          assignedAt: status === OrderStatus.pending || status === OrderStatus.pending_approval ? null : addDays(orderDate, 0),
          assignedBy: status === OrderStatus.pending || status === OrderStatus.pending_approval ? null : salesMgr.id,
          createdAt: orderDate,
          items: { createMany: { data: itemsData } },
        },
        select: { id: true },
      });
      orderCount++;

      // Discount approval record.
      if (isApprovalState) {
        await prisma.discountApproval.create({
          data: {
            orderId: order.id,
            requestedBy: r.salesmanId,
            status: status === OrderStatus.pending_approval ? DiscountApprovalStatus.pending : DiscountApprovalStatus.approved,
            reviewedBy: status === OrderStatus.pending_approval ? null : salesMgr.id,
            reviewedAt: status === OrderStatus.pending_approval ? null : orderDate,
            requestedAt: orderDate,
          },
        });
      }

      // Delivery proof + payment for terminal-delivered states.
      if (status === OrderStatus.delivered || status === OrderStatus.partial || status === OrderStatus.failed) {
        const dStatus =
          status === OrderStatus.delivered ? DeliveryStatus.delivered : status === OrderStatus.partial ? DeliveryStatus.partial : pick([DeliveryStatus.failed, DeliveryStatus.not_home]);
        await prisma.deliveryProof.create({
          data: {
            orderId: order.id,
            driverId: driver.id,
            status: dStatus,
            reasonCode: dStatus === DeliveryStatus.failed || dStatus === DeliveryStatus.not_home ? pick(['shop_closed', 'refused', 'no_cash', 'not_home']) : null,
            photoUrl: dStatus === DeliveryStatus.delivered || dStatus === DeliveryStatus.partial ? 'https://r2.example/proof.jpg' : null,
            photoUploaded: dStatus === DeliveryStatus.delivered || dStatus === DeliveryStatus.partial,
            gpsLat: D(31.45 + rnd() * 0.18),
            gpsLng: D(74.25 + rnd() * 0.22),
            confirmedAt: deliveryDate,
          },
        });
        if (status === OrderStatus.delivered || status === OrderStatus.partial) {
          const amt = status === OrderStatus.delivered ? Math.round(total) : Math.round(total * 0.6);
          const method = pick([PaymentMethod.cash, PaymentMethod.cash, PaymentMethod.credit, PaymentMethod.digital]);
          const reconciled = dAgo > 5 && chance(0.7);
          await prisma.payment.create({
            data: {
              orderId: order.id,
              retailerId: r.id,
              driverId: driver.id,
              amountPkr: D(method === PaymentMethod.credit ? 0 : amt),
              method,
              referenceNo: method === PaymentMethod.digital ? `TXN${ri(100000, 999999)}` : null,
              dueDate: method === PaymentMethod.credit ? addDays(deliveryDate, 14) : null,
              collectedAt: deliveryDate,
              reconciled,
              reconciledAt: reconciled ? addDays(deliveryDate, 1) : null,
              reconciledBy: reconciled ? finMgr.id : null,
            },
          });
          if (method === PaymentMethod.credit) {
            r.outstanding += amt;
          }
        }
      }

      // Visit row for the order.
      await prisma.visit.create({
        data: {
          salesmanId: r.salesmanId,
          retailerId: r.id,
          orderId: order.id,
          visitType: VisitType.order,
          visitedAt: orderDate,
        },
      });
    }

    // A few no-order visits per day.
    for (let v = 0; v < ri(2, 6); v++) {
      const r = pick(retailers);
      await prisma.visit.create({
        data: { salesmanId: r.salesmanId, retailerId: r.id, visitType: VisitType.no_order, note: 'Shop closed', visitedAt: orderDate },
      });
    }

    // ── POS sales for the day ───────────────────────────────────────────
    for (let s = 0; s < ri(2, 8); s++) {
      const nLines = ri(1, 4);
      const chosen = [...products].sort(() => rnd() - 0.5).slice(0, nLines);
      let total = 0;
      const items: Prisma.PosSaleItemCreateManyPosSaleInput[] = [];
      for (const p of chosen) {
        const qty = ri(1, 12);
        total += p.base * qty;
        items.push({ productId: p.id, unitType: p.unit, qty, unitPrice: D(p.base), effectivePrice: D(p.base) });
      }
      const discount = chance(0.3) ? ri(20, 200) : 0;
      const voided = chance(0.05);
      const sale = await prisma.posSale.create({
        data: {
          cashierId: chance(0.5) ? cashier.id : superAdmin.id,
          totalPkr: D(Math.max(0, Math.round(total - discount))),
          discountPkr: D(discount),
          paymentMethod: chance(0.7) ? POSPaymentMethod.cash : POSPaymentMethod.digital,
          referenceNo: chance(0.3) ? `POS${ri(10000, 99999)}` : null,
          voided,
          voidedBy: voided ? superAdmin.id : null,
          voidedAt: voided ? orderDate : null,
          createdAt: orderDate,
          items: { createMany: { data: items } },
        },
        select: { id: true },
      });
      posCount++;
      for (const it of items) {
        await prisma.stockMovement.create({
          data: {
            productId: it.productId,
            movementType: StockMovementType.pos_sale,
            qty: -it.qty,
            unitType: it.unitType,
            referenceId: sale.id,
            actorId: cashier.id,
            note: 'POS sale',
            createdAt: orderDate,
          },
        });
      }
    }
  }

  // ── Sync order_counters so app-created orders continue the sequence ───
  for (const [year, lastSeq] of Object.entries(orderSeqByYear)) {
    await prisma.orderCounter.upsert({
      where: { year: Number(year) },
      update: { lastSeq },
      create: { year: Number(year), lastSeq },
    });
  }

  // ── Vehicle stock for recent shift days (incl. discrepancies) ─────────
  console.log('Vehicle stock + EOD returns…');
  for (let dAgo = 5; dAgo >= 1; dAgo--) {
    const shiftDate = dayUTC(dAgo);
    for (const driver of drivers) {
      const loadProducts = [...products].sort(() => rnd() - 0.5).slice(0, ri(3, 7));
      for (const p of loadProducts) {
        const loaded = ri(20, 120);
        const delivered = ri(0, loaded);
        const logged = loaded - delivered;
        const verified = chance(0.2) ? logged - ri(1, 5) : logged; // some discrepancies
        await prisma.vehicleStock.create({
          data: {
            driverId: driver.id,
            shiftDate,
            productId: p.id,
            unitType: p.unit,
            qtyLoaded: loaded,
            qtyDelivered: delivered,
            qtyReturnedLogged: logged,
            qtyReturnedVerified: verified,
            discrepancyFlag: verified !== logged,
          },
        });
        await prisma.stockMovement.create({
          data: { productId: p.id, movementType: StockMovementType.load, qty: -loaded, unitType: p.unit, actorId: invMgr.id, createdAt: shiftDate },
        });
      }
    }
  }

  // ── Sync retailer outstanding balances ────────────────────────────────
  for (const r of retailers) {
    if (r.outstanding > 0) {
      await prisma.retailer.update({ where: { id: r.id }, data: { outstandingBalance: D(r.outstanding) } });
    }
  }

  const counts = {
    users: await prisma.user.count(),
    zones: await prisma.zone.count(),
    products: await prisma.product.count(),
    retailers: await prisma.retailer.count(),
    orders: orderCount,
    orderItems: await prisma.orderItem.count(),
    payments: await prisma.payment.count(),
    deliveryProofs: await prisma.deliveryProof.count(),
    posSales: posCount,
    visits: await prisma.visit.count(),
    vehicleStock: await prisma.vehicleStock.count(),
    stockMovements: await prisma.stockMovement.count(),
    discountApprovals: await prisma.discountApproval.count(),
  };
  console.log('\nDense seed complete:');
  console.table(counts);
  console.log('\nLogins (phone / pin):');
  console.log('  super_admin     03001234567 / 000000');
  console.log('  sales_manager   03001000001 / 100001');
  console.log('  inventory_mgr   03001000002 / 100002');
  console.log('  finance_mgr     03001000003 / 100003');
  console.log('  pos_cashier     03001000004 / 100004');
  console.log('  salesman        03001111111 / 111111  (Ahmed Ali)');
  console.log('  driver          03002222222 / 222222  (Bilal Khan)');
}

main()
  .catch((e) => {
    console.error('Dense seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
