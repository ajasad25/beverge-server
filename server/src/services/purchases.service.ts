import { Prisma, StockMovementType, LedgerEntryType, LedgerDirection, UnitType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';
import { lineTotal, purchaseTotals } from '../lib/purchase';

async function nextPurchaseNumber(tx: Prisma.TransactionClient, year: number): Promise<string> {
  const rows = await tx.$queryRaw<{ last_seq: number }[]>`
    INSERT INTO purchase_counters (year, last_seq) VALUES (${year}, 1)
    ON CONFLICT (year) DO UPDATE SET last_seq = purchase_counters.last_seq + 1
    RETURNING last_seq
  `;
  const seq = rows[0]?.last_seq;
  if (seq == null) {
    throw new HttpError(500, 'PURCHASE_NUMBER_FAILED', 'Could not allocate purchase number');
  }
  return `PUR-${year}-${String(seq).padStart(6, '0')}`;
}

export type PurchaseItemInput = { productId: string; qtyReceived: number; unitCostPkr: number };
export type CreatePurchaseInput = {
  supplierId: string;
  purchaseDate: string;
  supplierRef?: string | null;
  farePkr?: number;
  discountPkr?: number;
  note?: string | null;
  items: PurchaseItemInput[];
};

// Unified receipt: one $transaction creates the purchase + items, increments
// warehouse stock (+ StockMovement grn) per line, and posts the company-ledger
// entries (stock_purchase debit; fare debit; discount credit). Immutable after.
export async function createPurchase(actor: AuditActor, input: CreatePurchaseInput) {
  if (!input.items.length) throw new HttpError(400, 'EMPTY_PURCHASE', 'At least one line item is required');
  for (const it of input.items) {
    if (it.qtyReceived <= 0) throw new HttpError(400, 'INVALID_QTY', 'qtyReceived must be positive');
    if (it.unitCostPkr < 0) throw new HttpError(400, 'INVALID_COST', 'unitCostPkr must be non-negative');
  }
  const fare = input.farePkr ?? 0;
  const discount = input.discountPkr ?? 0;
  const purchaseDate = new Date(input.purchaseDate);
  const year = purchaseDate.getFullYear();

  return prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, isDeleted: false } });
    if (!supplier) throw new HttpError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');

    const productIds = input.items.map((i) => i.productId);
    const products = await tx.product.findMany({
      where: { id: { in: productIds }, isDeleted: false },
      include: { warehouseStock: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    const lines = input.items.map((it) => {
      const p = byId.get(it.productId);
      if (!p) throw new HttpError(404, 'PRODUCT_NOT_FOUND', `Product ${it.productId} not found`);
      if (!p.warehouseStock) {
        throw new HttpError(400, 'PRODUCT_NOT_STOCKED', `No warehouse stock row for ${p.name}`);
      }
      return { it, product: p, lineTotalPkr: lineTotal(it.qtyReceived, it.unitCostPkr) };
    });

    const totals = purchaseTotals(
      input.items.map((i) => ({ qtyReceived: i.qtyReceived, unitCostPkr: i.unitCostPkr })),
      fare,
      discount
    );

    const purchaseNumber = await nextPurchaseNumber(tx, year);
    const purchase = await tx.supplierPurchase.create({
      data: {
        supplierId: input.supplierId,
        purchaseNumber,
        purchaseDate,
        supplierRef: input.supplierRef ?? null,
        subtotalPkr: totals.subtotalPkr,
        farePkr: fare,
        discountPkr: discount,
        totalPkr: totals.totalPkr,
        note: input.note ?? null,
        createdBy: actor.id,
      },
    });

    for (const ln of lines) {
      await tx.supplierPurchaseItem.create({
        data: {
          purchaseId: purchase.id,
          productId: ln.product.id,
          unitType: ln.product.unitType as UnitType,
          qtyReceived: ln.it.qtyReceived,
          unitCostPkr: ln.it.unitCostPkr,
          lineTotalPkr: ln.lineTotalPkr,
        },
      });
      await tx.warehouseStock.update({
        where: { productId: ln.product.id },
        data: { quantityOnHand: { increment: ln.it.qtyReceived } },
      });
      await tx.stockMovement.create({
        data: {
          productId: ln.product.id,
          movementType: StockMovementType.grn,
          qty: ln.it.qtyReceived,
          unitType: ln.product.unitType as UnitType,
          referenceId: purchase.id,
          actorId: actor.id,
          note: `Purchase ${purchaseNumber}`,
        },
      });
    }

    // Ledger entries linked to this purchase.
    await tx.supplierLedgerEntry.create({
      data: {
        supplierId: input.supplierId,
        entryType: LedgerEntryType.stock_purchase,
        direction: LedgerDirection.debit,
        amountPkr: totals.subtotalPkr,
        entryDate: purchaseDate,
        referenceNo: purchase.purchaseNumber,
        purchaseId: purchase.id,
        createdBy: actor.id,
      },
    });
    if (fare > 0) {
      await tx.supplierLedgerEntry.create({
        data: {
          supplierId: input.supplierId,
          entryType: LedgerEntryType.fare,
          direction: LedgerDirection.debit,
          amountPkr: fare,
          entryDate: purchaseDate,
          referenceNo: purchase.purchaseNumber,
          purchaseId: purchase.id,
          createdBy: actor.id,
        },
      });
    }
    if (discount > 0) {
      await tx.supplierLedgerEntry.create({
        data: {
          supplierId: input.supplierId,
          entryType: LedgerEntryType.discount,
          direction: LedgerDirection.credit,
          amountPkr: discount,
          entryDate: purchaseDate,
          referenceNo: purchase.purchaseNumber,
          purchaseId: purchase.id,
          createdBy: actor.id,
        },
      });
    }

    await recordAudit(
      {
        actor,
        action: 'create',
        entityType: 'supplier_purchase',
        entityId: purchase.id,
        newValue: { purchaseNumber, totalPkr: totals.totalPkr },
      },
      tx
    );
    const items = await tx.supplierPurchaseItem.findMany({ where: { purchaseId: purchase.id } });
    return { purchase: { ...purchase, items } };
  });
}

export async function listPurchases(
  opts: { supplierId?: string; from?: Date; to?: Date; page?: number; pageSize?: number } = {}
) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const where: Prisma.SupplierPurchaseWhereInput = {
    ...(opts.supplierId && { supplierId: opts.supplierId }),
    ...((opts.from || opts.to) && {
      purchaseDate: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) },
    }),
  };
  const [purchases, total] = await Promise.all([
    prisma.supplierPurchase.findMany({
      where,
      orderBy: { purchaseDate: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { supplier: { select: { name: true } }, _count: { select: { items: true } } },
    }),
    prisma.supplierPurchase.count({ where }),
  ]);
  // Normalize the @db.Date timestamp to a plain YYYY-MM-DD (matches the company
  // ledger), so the web shows "2026-06-04" instead of a raw ISO timestamp.
  return {
    purchases: purchases.map((p) => ({ ...p, purchaseDate: p.purchaseDate.toISOString().slice(0, 10) })),
    total,
    page,
    pageSize,
  };
}

export async function getPurchase(id: string) {
  const purchase = await prisma.supplierPurchase.findUnique({
    where: { id },
    include: {
      supplier: { select: { name: true } },
      items: { include: { product: { select: { name: true, sku: true } } } },
    },
  });
  if (!purchase) throw new HttpError(404, 'PURCHASE_NOT_FOUND', 'Purchase not found');
  return { purchase: { ...purchase, purchaseDate: purchase.purchaseDate.toISOString().slice(0, 10) } };
}
