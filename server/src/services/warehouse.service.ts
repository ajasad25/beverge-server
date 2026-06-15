import {
  Prisma,
  Role,
  StockMovementType,
  UnitType,
  type StockMovement,
  type WarehouseStock,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { businessDateOnly, addDays } from '../lib/businessDay';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';
import { valuationValue } from '../lib/purchase';

// Driver roster for the SOD vehicle-loading dropdown. Lives on the warehouse
// router (super_admin + inventory_manager) so the dispatch desk can populate
// the driver picker without read access to the full /users list, which is
// restricted to super_admin + sales_manager.
export async function listDrivers(): Promise<{ drivers: { id: string; name: string }[] }> {
  const drivers = await prisma.user.findMany({
    where: { role: Role.driver, isActive: true, isDeleted: false },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return { drivers };
}

export type StockRow = {
  productId: string;
  sku: string;
  name: string;
  unitType: string;
  isActive: boolean;
  quantityOnHand: number;
  lowStockThreshold: number;
  belowThreshold: boolean;
  updatedAt: Date;
};

export type ListMovementsOpts = {
  productId?: string;
  movementType?: StockMovementType;
  fromDate?: Date;
  toDate?: Date;
  page?: number;
  pageSize?: number;
};

export async function listStock(
  opts: { lowStockOnly?: boolean; archivedOnly?: boolean } = {}
): Promise<StockRow[]> {
  // Default shows active products only (parity with the Products page).
  // lowStockOnly always implies active-only; archivedOnly shows ONLY archived
  // (deactivated) products — mirroring the Users "show deactivated" toggle.
  const productFilter =
    !opts.lowStockOnly && opts.archivedOnly ? { isActive: false } : { isActive: true };
  const rows = await prisma.warehouseStock.findMany({
    where: { product: { isDeleted: false, ...productFilter } },
    include: {
      product: { select: { id: true, sku: true, name: true, unitType: true, isActive: true } },
    },
    orderBy: { product: { name: 'asc' } },
  });
  const mapped: StockRow[] = rows.map((r) => ({
    productId: r.product.id,
    sku: r.product.sku,
    name: r.product.name,
    unitType: r.product.unitType,
    isActive: r.product.isActive,
    quantityOnHand: r.quantityOnHand,
    lowStockThreshold: r.lowStockThreshold,
    // A threshold of 0 means "no low-stock alerting", so a brand-new product
    // (0 on hand, 0 threshold) is not flagged LOW; only > 0 thresholds alert.
    belowThreshold: r.lowStockThreshold > 0 && r.quantityOnHand <= r.lowStockThreshold,
    updatedAt: r.updatedAt,
  }));
  return opts.lowStockOnly ? mapped.filter((r) => r.belowThreshold) : mapped;
}

export async function getStock(productId: string): Promise<StockRow> {
  const row = await prisma.warehouseStock.findUnique({
    where: { productId },
    include: { product: { select: { id: true, sku: true, name: true, unitType: true, isActive: true, isDeleted: true } } },
  });
  if (!row || row.product.isDeleted) {
    throw new HttpError(404, 'STOCK_NOT_FOUND', 'No warehouse stock record for that product');
  }
  return {
    productId: row.product.id,
    sku: row.product.sku,
    name: row.product.name,
    unitType: row.product.unitType,
    isActive: row.product.isActive,
    quantityOnHand: row.quantityOnHand,
    lowStockThreshold: row.lowStockThreshold,
    belowThreshold: row.lowStockThreshold > 0 && row.quantityOnHand <= row.lowStockThreshold,
    updatedAt: row.updatedAt,
  };
}

export async function updateThreshold(
  actor: AuditActor,
  productId: string,
  threshold: number
): Promise<WarehouseStock> {
  if (threshold < 0) {
    throw new HttpError(400, 'INVALID_THRESHOLD', 'Threshold must be non-negative');
  }
  const existing = await prisma.warehouseStock.findUnique({ where: { productId } });
  if (!existing) {
    throw new HttpError(404, 'STOCK_NOT_FOUND', 'No warehouse stock record for that product');
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.warehouseStock.update({
      where: { productId },
      data: { lowStockThreshold: threshold },
    });
    await recordAudit(
      {
        actor,
        action: 'update_threshold',
        entityType: 'warehouse_stock',
        entityId: existing.id,
        oldValue: { lowStockThreshold: existing.lowStockThreshold },
        newValue: { lowStockThreshold: threshold },
      },
      tx
    );
    return updated;
  });
}

export type AdjustStockInput = {
  // Signed: positive = inflow to warehouse, negative = outflow.
  delta: number;
  reasonCode: string;
  note?: string;
};

// Manual stock adjustment per SRS WH06. Atomically updates warehouse_stock
// and writes the matching stock_movements row of type 'adjustment'.
export async function adjustStock(
  actor: AuditActor,
  productId: string,
  input: AdjustStockInput
): Promise<{ stock: WarehouseStock; movement: StockMovement }> {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new HttpError(400, 'INVALID_DELTA', 'Delta must be a non-zero integer');
  }
  if (!input.reasonCode.trim()) {
    throw new HttpError(400, 'REASON_REQUIRED', 'Reason code is required for manual adjustments');
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.warehouseStock.findUnique({
      where: { productId },
      include: { product: { select: { isDeleted: true, unitType: true } } },
    });
    if (!existing || existing.product.isDeleted) {
      throw new HttpError(404, 'STOCK_NOT_FOUND', 'No warehouse stock record for that product');
    }
    // INV-1: atomic, guarded, RELATIVE mutation. The WHERE guard makes a
    // would-go-negative decrement match zero rows instead of a racy
    // read-compute-write that could lose a concurrent GRN/POS/load update or
    // drive stock below zero. `increment` with a negative delta decrements.
    const guard = input.delta < 0 ? { quantityOnHand: { gte: -input.delta } } : {};
    const res = await tx.warehouseStock.updateMany({
      where: { productId, ...guard },
      data: { quantityOnHand: { increment: input.delta } },
    });
    if (res.count !== 1) {
      throw new HttpError(
        400,
        'STOCK_WOULD_GO_NEGATIVE',
        `Adjustment would leave stock negative; current is ${existing.quantityOnHand}`
      );
    }
    const updated = await tx.warehouseStock.findUniqueOrThrow({ where: { productId } });
    const movement = await tx.stockMovement.create({
      data: {
        productId,
        movementType: StockMovementType.adjustment,
        qty: input.delta,
        unitType: existing.product.unitType,
        actorId: actor.id,
        reasonCode: input.reasonCode,
        note: input.note ?? null,
      },
    });
    await recordAudit(
      {
        actor,
        action: 'adjust_stock',
        entityType: 'warehouse_stock',
        entityId: existing.id,
        oldValue: { quantityOnHand: existing.quantityOnHand },
        newValue: {
          quantityOnHand: updated.quantityOnHand,
          delta: input.delta,
          reasonCode: input.reasonCode,
        },
      },
      tx
    );
    return { stock: updated, movement };
  });
}

export async function listMovements(opts: ListMovementsOpts = {}): Promise<{
  movements: StockMovement[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const where: Prisma.StockMovementWhereInput = {
    ...(opts.productId && { productId: opts.productId }),
    ...(opts.movementType && { movementType: opts.movementType }),
    ...((opts.fromDate || opts.toDate) && {
      createdAt: {
        ...(opts.fromDate && { gte: opts.fromDate }),
        ...(opts.toDate && { lte: opts.toDate }),
      },
    }),
  };
  const [movements, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.stockMovement.count({ where }),
  ]);
  return { movements, total, page, pageSize };
}

// ─── GRN — goods received from supplier (SRS WH03) ───────────────────────
export type GrnInput = {
  productId: string;
  unitType: UnitType;
  qtyReceived: number;
  supplierRef?: string | null;
};

export async function recordGrn(
  actor: AuditActor,
  input: GrnInput
): Promise<{ grnId: string; quantityOnHand: number }> {
  if (input.qtyReceived <= 0) {
    throw new HttpError(400, 'INVALID_QTY', 'qtyReceived must be positive');
  }
  return prisma.$transaction(async (tx) => {
    const stock = await tx.warehouseStock.findUnique({ where: { productId: input.productId } });
    if (!stock) {
      throw new HttpError(404, 'PRODUCT_NOT_STOCKED', 'No warehouse stock row for that product');
    }
    const grn = await tx.grnRecord.create({
      data: {
        productId: input.productId,
        qtyReceived: input.qtyReceived,
        unitType: input.unitType,
        supplierRef: input.supplierRef ?? null,
        receivedBy: actor.id,
      },
    });
    const updated = await tx.warehouseStock.update({
      where: { productId: input.productId },
      data: { quantityOnHand: { increment: input.qtyReceived } },
    });
    await tx.stockMovement.create({
      data: {
        productId: input.productId,
        movementType: StockMovementType.grn,
        qty: input.qtyReceived,
        unitType: input.unitType,
        referenceId: grn.id,
        actorId: actor.id,
        note: input.supplierRef ? `GRN ${input.supplierRef}` : 'GRN',
      },
    });
    await recordAudit(
      { actor, action: 'grn', entityType: 'grn_record', entityId: grn.id, newValue: grn },
      tx
    );
    return { grnId: grn.id, quantityOnHand: updated.quantityOnHand };
  });
}

// ─── EOD returns verification (SRS WH05 + §5.2 conflict resolution) ───────
// The driver logged qtyReturnedLogged at EOD (S6). The warehouse manager
// physically counts and enters the verified figure here. Per §5.2 the
// physical count WINS: warehouse stock is incremented by the verified qty
// (a 'return' movement) and discrepancy_flag reflects logged vs verified so
// Super Admin can investigate (SRS §9.6 stock-discrepancy alert).
export type ReturnsVerifyLine = {
  vehicleStockId: string;
  qtyReturnedVerified: number;
};

// Every loaded vehicle line still awaiting the warehouse physical count
// (qtyReturnedVerified IS NULL) — whether or not the driver logged a return.
// This lets the warehouse reconcile vehicles loaded from the admin Dispatch
// desk directly, not only those a driver self-logged via the mobile app, so
// the SOD-load → EOD-verify loop is complete on the admin side.
export async function listPendingReturns(): Promise<
  Array<{
    id: string;
    driverId: string;
    driverName: string;
    shiftDate: Date;
    productId: string;
    productName: string;
    sku: string;
    unitType: string;
    qtyLoaded: number;
    qtyDelivered: number;
    qtyReturnedLogged: number | null;
    qtyReturnedVerified: number | null;
    discrepancyFlag: boolean;
  }>
> {
  const rows = await prisma.vehicleStock.findMany({
    where: { qtyReturnedVerified: null },
    orderBy: [{ shiftDate: 'desc' }, { driverId: 'asc' }],
    include: {
      driver: { select: { name: true } },
      product: { select: { name: true, sku: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    driverId: r.driverId,
    driverName: r.driver.name,
    shiftDate: r.shiftDate,
    productId: r.productId,
    productName: r.product.name,
    sku: r.product.sku,
    unitType: r.unitType,
    qtyLoaded: r.qtyLoaded,
    qtyDelivered: r.qtyDelivered,
    qtyReturnedLogged: r.qtyReturnedLogged,
    qtyReturnedVerified: r.qtyReturnedVerified,
    discrepancyFlag: r.discrepancyFlag,
  }));
}

// Already-reconciled returns (qtyReturnedVerified IS NOT NULL) for the Dispatch
// "verified / history" view (FEAT-5), so completed reconciliations and their
// driver-vs-warehouse discrepancies remain visible instead of vanishing once
// verified. Bounded to a recent shift window so the history query stays cheap.
export async function listVerifiedReturns(opts: { days?: number } = {}): Promise<
  Array<{
    id: string;
    driverId: string;
    driverName: string;
    shiftDate: Date;
    productId: string;
    productName: string;
    sku: string;
    unitType: string;
    qtyLoaded: number;
    qtyDelivered: number;
    qtyReturnedLogged: number | null;
    qtyReturnedVerified: number | null;
    discrepancyFlag: boolean;
  }>
> {
  const days = opts.days && opts.days > 0 ? Math.min(opts.days, 365) : 14;
  const since = addDays(businessDateOnly(), -days);
  const rows = await prisma.vehicleStock.findMany({
    where: { qtyReturnedVerified: { not: null }, shiftDate: { gte: since } },
    orderBy: [{ shiftDate: 'desc' }, { driverId: 'asc' }],
    include: {
      driver: { select: { name: true } },
      product: { select: { name: true, sku: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    driverId: r.driverId,
    driverName: r.driver.name,
    shiftDate: r.shiftDate,
    productId: r.productId,
    productName: r.product.name,
    sku: r.product.sku,
    unitType: r.unitType,
    qtyLoaded: r.qtyLoaded,
    qtyDelivered: r.qtyDelivered,
    qtyReturnedLogged: r.qtyReturnedLogged,
    qtyReturnedVerified: r.qtyReturnedVerified,
    discrepancyFlag: r.discrepancyFlag,
  }));
}

export async function verifyReturns(
  actor: AuditActor,
  lines: ReturnsVerifyLine[]
): Promise<{ verified: number; discrepancies: number }> {
  if (lines.length === 0) {
    throw new HttpError(400, 'NO_LINES', 'At least one line is required');
  }
  return prisma.$transaction(async (tx) => {
    // Fetch all targeted rows in ONE query rather than a findUnique per line —
    // the loop was an N+1 inside the transaction, lengthening lock hold time (INV-1).
    const rows = await tx.vehicleStock.findMany({
      where: { id: { in: lines.map((l) => l.vehicleStockId) } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    let discrepancies = 0;
    for (const line of lines) {
      if (line.qtyReturnedVerified < 0) {
        throw new HttpError(400, 'INVALID_QTY', 'qtyReturnedVerified must be >= 0');
      }
      const vs = byId.get(line.vehicleStockId);
      if (!vs) {
        throw new HttpError(404, 'VEHICLE_STOCK_NOT_FOUND', line.vehicleStockId);
      }
      if (vs.qtyReturnedVerified !== null) {
        // Already reconciled — idempotent skip (don't double-credit stock).
        continue;
      }
      // Only a real discrepancy when the driver actually logged a figure that
      // disagrees with the physical count. Admin-direct reconciliation (no
      // driver log) must not raise a false stock-discrepancy alert.
      const flag = vs.qtyReturnedLogged !== null && vs.qtyReturnedLogged !== line.qtyReturnedVerified;
      if (flag) discrepancies += 1;
      await tx.vehicleStock.update({
        where: { id: vs.id },
        data: { qtyReturnedVerified: line.qtyReturnedVerified, discrepancyFlag: flag },
      });
      // Physical count wins (§5.2): the verified units re-enter the warehouse.
      if (line.qtyReturnedVerified > 0) {
        await tx.warehouseStock.update({
          where: { productId: vs.productId },
          data: { quantityOnHand: { increment: line.qtyReturnedVerified } },
        });
        await tx.stockMovement.create({
          data: {
            productId: vs.productId,
            movementType: StockMovementType.return,
            qty: line.qtyReturnedVerified,
            unitType: vs.unitType,
            referenceId: vs.id,
            actorId: actor.id,
            note: flag
              ? `Return verified (DISCREPANCY: driver logged ${vs.qtyReturnedLogged})`
              : 'Return verified',
          },
        });
      }
      await recordAudit(
        {
          actor,
          action: 'verify_returns',
          entityType: 'vehicle_stock',
          entityId: vs.id,
          oldValue: { qtyReturnedLogged: vs.qtyReturnedLogged },
          newValue: { qtyReturnedVerified: line.qtyReturnedVerified, discrepancyFlag: flag },
        },
        tx
      );
    }
    return { verified: lines.length, discrepancies };
  });
}

// Stock valuation on a latest-cost basis: each product valued at its most
// recent supplier purchase unit cost × quantity on hand (SRS §10, S10).
// Products never purchased through the ledger have no cost → value 0.
export async function valuation(): Promise<{
  rows: {
    productId: string;
    sku: string;
    name: string;
    unitType: string;
    quantityOnHand: number;
    latestUnitCostPkr: number | null;
    valuePkr: number;
  }[];
  totalValuePkr: number;
}> {
  const stock = await prisma.warehouseStock.findMany({
    where: { product: { isDeleted: false } },
    include: { product: { select: { sku: true, name: true, unitType: true } } },
    orderBy: { product: { name: 'asc' } },
  });
  // Latest cost per product = most recent purchase line.
  const lines = await prisma.supplierPurchaseItem.findMany({
    select: {
      productId: true,
      unitCostPkr: true,
      purchase: { select: { purchaseDate: true, createdAt: true } },
    },
    orderBy: [{ purchase: { purchaseDate: 'desc' } }, { purchase: { createdAt: 'desc' } }],
  });
  const latestByProduct = new Map<string, number>();
  for (const l of lines) {
    if (!latestByProduct.has(l.productId)) latestByProduct.set(l.productId, Number(l.unitCostPkr));
  }
  const rows = stock.map((s) => {
    const cost = latestByProduct.get(s.productId) ?? null;
    return {
      productId: s.productId,
      sku: s.product.sku,
      name: s.product.name,
      unitType: s.product.unitType,
      quantityOnHand: s.quantityOnHand,
      latestUnitCostPkr: cost,
      valuePkr: valuationValue(s.quantityOnHand, cost),
    };
  });
  const totalValuePkr = rows.reduce((sum, r) => sum + r.valuePkr, 0);
  return { rows, totalValuePkr: Math.round((totalValuePkr + Number.EPSILON) * 100) / 100 };
}

// ─── Start-of-day vehicle loading (admin-initiated) ───────────────────────
// Lets the warehouse manager / super admin load (and amend) a driver's vehicle
// from the admin panel. Re-submitting reconciles the load to the desired set:
// new SKUs deduct stock, increased quantities deduct the delta, reduced/removed
// lines return units to the warehouse — each logged as a 'load' movement, all
// atomic (SRS §5.2, invariant #10). The load is amendable until the driver
// starts delivering (any qtyDelivered > 0 → frozen), i.e. "before the driver
// leaves".


export type LoadVehicleLine = { productId: string; unitType: UnitType; qty: number };

export async function loadVehicle(
  actor: AuditActor,
  driverId: string,
  lines: LoadVehicleLine[]
): Promise<{ count: number }> {
  const active = lines.filter((l) => l.qty > 0);
  if (active.length === 0) {
    throw new HttpError(400, 'NO_LINES', 'At least one SKU with a positive quantity is required');
  }
  const driver = await prisma.user.findUnique({ where: { id: driverId } });
  if (!driver || driver.role !== 'driver' || !driver.isActive || driver.isDeleted) {
    throw new HttpError(400, 'INVALID_DRIVER', 'driverId must reference an active driver');
  }
  const shiftDate = businessDateOnly();

  const keyOf = (productId: string, unitType: UnitType) => `${productId}__${unitType}`;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.vehicleStock.findMany({ where: { driverId, shiftDate } });
    // Frozen once the driver has started delivering ("driver has left").
    if (existing.some((e) => e.qtyDelivered > 0)) {
      throw new HttpError(
        409,
        'LOAD_LOCKED',
        'This driver has started delivering; the load can no longer be changed'
      );
    }
    const existingByKey = new Map(existing.map((e) => [keyOf(e.productId, e.unitType), e]));
    const desiredByKey = new Map(active.map((l) => [keyOf(l.productId, l.unitType), l]));

    // Reconcile each desired line against the current load (create / +Δ / −Δ).
    for (const [, line] of desiredByKey) {
      const ex = existingByKey.get(keyOf(line.productId, line.unitType));
      const delta = line.qty - (ex?.qtyLoaded ?? 0);
      if (delta === 0) continue;
      if (delta > 0) {
        // Take Δ more units out of the warehouse (guarded against oversell).
        const dec = await tx.warehouseStock.updateMany({
          where: { productId: line.productId, quantityOnHand: { gte: delta } },
          data: { quantityOnHand: { decrement: delta } },
        });
        if (dec.count !== 1) {
          const s = await tx.warehouseStock.findUnique({ where: { productId: line.productId } });
          throw new HttpError(
            409,
            'INSUFFICIENT_STOCK',
            `Only ${s?.quantityOnHand ?? 0} of ${line.productId} on hand`
          );
        }
      } else {
        // Load reduced before dispatch → return the units to the warehouse.
        await tx.warehouseStock.update({
          where: { productId: line.productId },
          data: { quantityOnHand: { increment: -delta } },
        });
      }
      const vs = ex
        ? await tx.vehicleStock.update({ where: { id: ex.id }, data: { qtyLoaded: line.qty } })
        : await tx.vehicleStock.create({
            data: { driverId, shiftDate, productId: line.productId, unitType: line.unitType, qtyLoaded: line.qty },
          });
      await tx.stockMovement.create({
        data: {
          productId: line.productId,
          movementType: StockMovementType.load,
          // Negative = units left the warehouse; positive = returned.
          qty: -delta,
          unitType: line.unitType,
          referenceId: vs.id,
          actorId: actor.id,
          note: delta > 0 ? 'Vehicle loading (admin)' : 'Vehicle load reduced (admin)',
        },
      });
    }

    // Lines dropped from the load entirely: return units, remove the row.
    for (const [k, ex] of existingByKey) {
      if (desiredByKey.has(k)) continue;
      await tx.warehouseStock.update({
        where: { productId: ex.productId },
        data: { quantityOnHand: { increment: ex.qtyLoaded } },
      });
      await tx.stockMovement.create({
        data: {
          productId: ex.productId,
          movementType: StockMovementType.load,
          qty: ex.qtyLoaded,
          unitType: ex.unitType,
          referenceId: ex.id,
          actorId: actor.id,
          note: 'Vehicle load line removed (admin)',
        },
      });
      await tx.vehicleStock.delete({ where: { id: ex.id } });
    }

    await recordAudit(
      { actor, action: 'load_vehicle', entityType: 'vehicle_stock', entityId: driverId },
      tx
    );
    return { count: active.length };
  });
}

// Today's loaded vehicles, grouped per driver, for the admin dispatch view.
export async function listLoadedToday(): Promise<
  Array<{
    driverId: string;
    driverName: string;
    loaded: boolean;
    lines: Array<{ productId: string; sku: string; name: string; unitType: string; qtyLoaded: number }>;
  }>
> {
  const shiftDate = businessDateOnly();
  const drivers = await prisma.user.findMany({
    where: { role: 'driver', isActive: true, isDeleted: false },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const rows = await prisma.vehicleStock.findMany({
    where: { shiftDate },
    include: { product: { select: { sku: true, name: true } } },
  });
  return drivers.map((d) => {
    const lines = rows
      .filter((r) => r.driverId === d.id)
      .map((r) => ({
        productId: r.productId,
        sku: r.product.sku,
        name: r.product.name,
        unitType: r.unitType,
        qtyLoaded: r.qtyLoaded,
      }));
    return { driverId: d.id, driverName: d.name, loaded: lines.length > 0, lines };
  });
}
