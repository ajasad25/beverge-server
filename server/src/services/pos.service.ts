import {
  POSPaymentMethod,
  Prisma,
  Role,
  StockMovementType,
  type PosSale,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { businessDayBounds, businessDayBoundsFromKey, businessDayKey } from '../lib/businessDay';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';

export type Actor = AuditActor & { role: Role };

export type SaleItemInput = { productId: string; qty: number };
export type CreateSaleInput = {
  items: SaleItemInput[];
  discountPkr?: number | string;
  paymentMethod: POSPaymentMethod;
  referenceNo?: string | null;
  // Cash tendered — drives change calculation (POS09). Ignored for digital.
  cashReceived?: number | string;
};

export type SaleResult = {
  sale: PosSale & { items: { productId: string; qty: number; unitPrice: string }[] };
  changePkr: string;
};

// SRS §3.2 / POS01-15. POS deducts warehouse stock SYNCHRONOUSLY at confirm
// (architectural invariant #10 — unlike field orders which deduct on driver
// loading). Cashier uses catalog base price only (POS14); discount is a
// single sale-level figure capped by company_settings (POS07).
export async function createSale(actor: Actor, input: CreateSaleInput): Promise<SaleResult> {
  if (input.items.length === 0) {
    throw new HttpError(400, 'EMPTY_SALE', 'A sale needs at least one item');
  }
  return prisma.$transaction(async (tx) => {
    const ids = input.items.map((i) => i.productId);
    const products = await tx.product.findMany({
      where: { id: { in: ids }, isDeleted: false, isActive: true },
      include: { warehouseStock: true },
    });
    const pmap = new Map(products.map((p) => [p.id, p]));

    let subtotal = new Prisma.Decimal(0);
    const lineRows: {
      productId: string;
      unitType: (typeof products)[number]['unitType'];
      qty: number;
      unitPrice: Prisma.Decimal;
    }[] = [];
    for (const item of input.items) {
      if (item.qty <= 0) throw new HttpError(400, 'INVALID_QTY', 'Quantity must be positive');
      const p = pmap.get(item.productId);
      if (!p) throw new HttpError(404, 'PRODUCT_NOT_FOUND', `Unknown product ${item.productId}`);
      const onHand = p.warehouseStock?.quantityOnHand ?? 0;
      if (onHand < item.qty) {
        throw new HttpError(
          409,
          'INSUFFICIENT_STOCK',
          `Only ${onHand} of ${p.name} in stock (requested ${item.qty})`
        );
      }
      subtotal = subtotal.add(p.basePrice.mul(item.qty));
      lineRows.push({ productId: p.id, unitType: p.unitType, qty: item.qty, unitPrice: p.basePrice });
    }

    const discount = new Prisma.Decimal(input.discountPkr ?? 0);
    if (discount.lt(0)) throw new HttpError(400, 'INVALID_DISCOUNT', 'Discount cannot be negative');
    // POS07 / §9.7: cap by the configured cashier limit. Super Admin bypasses.
    // The limit is a hard ceiling: 0 means "no cashier discount allowed" (the
    // safe default), NOT "unlimited" — so a fresh install can't ring near-zero
    // sales. A positive value caps the per-sale discount.
    if (actor.role !== Role.super_admin && discount.gt(0)) {
      const settings = await tx.companySettings.findFirst({
        select: { posCashierDiscountLimit: true },
      });
      const cap = settings?.posCashierDiscountLimit ?? new Prisma.Decimal(0);
      if (discount.gt(cap)) {
        throw new HttpError(
          403,
          'DISCOUNT_OVER_LIMIT',
          cap.lte(0)
            ? 'Cashier discounts are not permitted'
            : `Discount ${discount} exceeds the cashier limit of ${cap}`
        );
      }
    }
    if (discount.gt(subtotal)) {
      throw new HttpError(400, 'INVALID_DISCOUNT', 'Discount exceeds sale subtotal');
    }
    const total = subtotal.sub(discount);

    if (input.paymentMethod === POSPaymentMethod.digital && !input.referenceNo?.trim()) {
      throw new HttpError(400, 'REFERENCE_REQUIRED', 'Digital payment needs a reference number');
    }
    let change = new Prisma.Decimal(0);
    if (input.paymentMethod === POSPaymentMethod.cash && input.cashReceived != null) {
      const received = new Prisma.Decimal(input.cashReceived);
      if (received.lt(total)) {
        throw new HttpError(400, 'INSUFFICIENT_CASH', 'Cash received is less than the total');
      }
      change = received.sub(total);
    }

    const sale = await tx.posSale.create({
      data: {
        cashierId: actor.id,
        totalPkr: total,
        discountPkr: discount,
        paymentMethod: input.paymentMethod,
        referenceNo: input.referenceNo ?? null,
        items: {
          create: lineRows.map((l) => ({
            productId: l.productId,
            unitType: l.unitType,
            qty: l.qty,
            unitPrice: l.unitPrice,
            effectivePrice: l.unitPrice,
          })),
        },
      },
      include: { items: true },
    });

    // Synchronous stock deduction + POS_SALE movement per line (POS10/POS22).
    // The decrement is a guarded updateMany (only when quantityOnHand >= qty),
    // so two concurrent cashier tabs selling the last units can't drive stock
    // negative — the early read-check above is only for a friendly error.
    for (const l of lineRows) {
      const dec = await tx.warehouseStock.updateMany({
        where: { productId: l.productId, quantityOnHand: { gte: l.qty } },
        data: { quantityOnHand: { decrement: l.qty } },
      });
      if (dec.count !== 1) {
        throw new HttpError(
          409,
          'INSUFFICIENT_STOCK',
          `Stock changed during the sale; not enough of ${l.productId} on hand`
        );
      }
      await tx.stockMovement.create({
        data: {
          productId: l.productId,
          movementType: StockMovementType.pos_sale,
          qty: -l.qty,
          unitType: l.unitType,
          referenceId: sale.id,
          actorId: actor.id,
          note: 'POS sale',
        },
      });
    }
    await recordAudit(
      { actor, action: 'pos_sale', entityType: 'pos_sale', entityId: sale.id, newValue: { total } },
      tx
    );

    return {
      sale: {
        ...sale,
        items: sale.items.map((i) => ({
          productId: i.productId,
          qty: i.qty,
          unitPrice: i.unitPrice.toString(),
        })),
      },
      changePkr: change.toString(),
    };
  });
}

// POS13: post-confirmation void is Super Admin only. Reverses stock so the
// warehouse ledger stays truthful; the sale row is kept with voided=true
// (no hard deletes — §12).
export async function voidSale(actor: Actor, saleId: string): Promise<PosSale> {
  if (actor.role !== Role.super_admin) {
    throw new HttpError(403, 'SUPER_ADMIN_ONLY', 'Post-confirmation void requires Super Admin');
  }
  return prisma.$transaction(async (tx) => {
    const sale = await tx.posSale.findUnique({ where: { id: saleId }, include: { items: true } });
    if (!sale) throw new HttpError(404, 'SALE_NOT_FOUND', 'POS sale not found');
    if (sale.voided) return sale; // idempotent
    for (const it of sale.items) {
      await tx.warehouseStock.update({
        where: { productId: it.productId },
        data: { quantityOnHand: { increment: it.qty } },
      });
      await tx.stockMovement.create({
        data: {
          productId: it.productId,
          movementType: StockMovementType.adjustment,
          qty: it.qty,
          unitType: it.unitType,
          referenceId: sale.id,
          actorId: actor.id,
          reasonCode: 'pos_void',
          note: 'POS sale voided — stock returned',
        },
      });
    }
    const updated = await tx.posSale.update({
      where: { id: saleId },
      data: { voided: true, voidedBy: actor.id, voidedAt: new Date() },
    });
    await recordAudit(
      { actor, action: 'pos_void', entityType: 'pos_sale', entityId: saleId },
      tx
    );
    return updated;
  });
}

// createdAt is timestamptz, so day bounds are real instants for the Asia/
// Karachi business day (see lib/businessDay).
function dayRange(dateStr?: string): { gte: Date; lt: Date } {
  return dateStr ? businessDayBoundsFromKey(dateStr) : businessDayBounds();
}

export async function listSales(opts: { date?: string; cashierId?: string }) {
  const { gte, lt } = dayRange(opts.date);
  return prisma.posSale.findMany({
    where: {
      createdAt: { gte, lt },
      ...(opts.cashierId ? { cashierId: opts.cashierId } : {}),
    },
    include: { cashier: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

// scopeCashierId, when set (pos_cashier actor), restricts the lookup to that
// cashier's own sale so a cashier cannot read another cashier's receipt by id.
export async function getSale(saleId: string, scopeCashierId?: string) {
  const sale = await prisma.posSale.findFirst({
    where: { id: saleId, ...(scopeCashierId ? { cashierId: scopeCashierId } : {}) },
    include: {
      items: { include: { product: { select: { name: true, sku: true } } } },
      cashier: { select: { name: true } },
    },
  });
  if (!sale) throw new HttpError(404, 'SALE_NOT_FOUND', 'POS sale not found');
  const company = await prisma.companySettings.findFirst();
  return { sale, company };
}

// POS24/§10.4 daily summary for Finance: revenue + split by method,
// excluding voided sales.
export async function dailySummary(date?: string, cashierId?: string) {
  const { gte, lt } = dayRange(date);
  const sales = await prisma.posSale.findMany({
    where: { createdAt: { gte, lt }, voided: false, ...(cashierId && { cashierId }) },
    select: { totalPkr: true, discountPkr: true, paymentMethod: true },
  });
  let cash = new Prisma.Decimal(0);
  let digital = new Prisma.Decimal(0);
  let discount = new Prisma.Decimal(0);
  for (const s of sales) {
    discount = discount.add(s.discountPkr);
    if (s.paymentMethod === POSPaymentMethod.cash) cash = cash.add(s.totalPkr);
    else digital = digital.add(s.totalPkr);
  }
  return {
    // The PKT calendar day — NOT derived from `gte`, which is the prior UTC
    // evening once the Asia/Karachi midnight offset is applied.
    date: date ?? businessDayKey(),
    count: sales.length,
    cashPkr: cash.toString(),
    digitalPkr: digital.toString(),
    totalPkr: cash.add(digital).toString(),
    discountPkr: discount.toString(),
  };
}
