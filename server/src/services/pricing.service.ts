import { DiscountType, Role, type Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../middleware/error.middleware';
import {
  checkSalesmanDiscountLimit,
  computeLine,
  computeOrderTotals,
  type ApprovalCheck,
  type LineResult,
} from '../lib/pricing';

export type PreviewItem = {
  productId: string;
  qty: number;
  discountType?: DiscountType;
  discountValue?: number | string;
};

export type Actor = {
  id: string;
  role: Role;
};

export type PreviewLine = {
  productId: string;
  sku: string;
  name: string;
  unitType: string;
  basePrice: string;
  specialPrice: string | null;
  floor: string;
  effectiveUnitPrice: string;
  discountedUnitPrice: string;
  discountAmountPerUnit: string;
  qty: number;
  lineTotal: string;
  clampedToFloor: boolean;
};

export type PreviewResult = {
  retailerId: string;
  lines: PreviewLine[];
  subtotal: string;
  totalDiscountPkr: string;
  approval: {
    requiresApproval: boolean;
    reason: 'pct_exceeded' | 'pkr_exceeded' | null;
    maxLinePct: string;
    totalPkr: string;
  };
};

function lineToWire(line: LineResult, p: { id: string; sku: string; name: string; unitType: string }): PreviewLine {
  return {
    productId: p.id,
    sku: p.sku,
    name: p.name,
    unitType: p.unitType,
    basePrice: line.basePrice.toString(),
    specialPrice: line.specialPrice?.toString() ?? null,
    floor: line.floor.toString(),
    effectiveUnitPrice: line.effectiveUnitPrice.toString(),
    discountedUnitPrice: line.discountedUnitPrice.toString(),
    discountAmountPerUnit: line.discountAmountPerUnit.toString(),
    qty: line.qty,
    lineTotal: line.lineTotal.toString(),
    clampedToFloor: line.clampedToFloor,
  };
}

// Compute the effective prices, floor checks, and approval requirement for a
// proposed order. Reads-only; never writes. Salesman pricing on the device
// runs the same math for UX, but submission must call this server-side
// because pricing floors are enforced authoritatively here (SRS §15.2).
export async function previewOrder(actor: Actor, retailerId: string, items: PreviewItem[]): Promise<PreviewResult> {
  if (items.length === 0) {
    throw new HttpError(400, 'EMPTY_ORDER', 'At least one line item is required');
  }

  // Salesman scope: can only preview for their own retailers (SRS §15.2)
  const retailer = await prisma.retailer.findFirst({
    where: {
      id: retailerId,
      isDeleted: false,
      ...(actor.role === Role.salesman && { primarySalesmanId: actor.id }),
    },
    select: { id: true, primarySalesmanId: true },
  });
  if (!retailer) {
    throw new HttpError(404, 'RETAILER_NOT_FOUND', 'Retailer not found or not assigned to you');
  }

  const productIds = [...new Set(items.map((i) => i.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, isDeleted: false },
    select: { id: true, sku: true, name: true, unitType: true, basePrice: true },
  });
  if (products.length !== productIds.length) {
    throw new HttpError(400, 'UNKNOWN_PRODUCTS', 'One or more products not found or archived');
  }
  const productById = new Map(products.map((p) => [p.id, p]));

  const specialPrices = await prisma.retailerPrice.findMany({
    where: { retailerId, productId: { in: productIds } },
    select: { productId: true, specialPrice: true },
  });
  const specialByProduct = new Map(specialPrices.map((s) => [s.productId, s.specialPrice]));

  const results: LineResult[] = [];
  const wireLines: PreviewLine[] = [];
  for (const item of items) {
    const product = productById.get(item.productId);
    if (!product) {
      throw new HttpError(400, 'UNKNOWN_PRODUCT', `Product ${item.productId} not found`);
    }
    const line = computeLine({
      basePrice: product.basePrice,
      specialPrice: specialByProduct.get(item.productId) ?? null,
      discountType: item.discountType ?? DiscountType.none,
      discountValue: item.discountValue ?? 0,
      qty: item.qty,
    });
    results.push(line);
    wireLines.push(lineToWire(line, product));
  }

  const totals = computeOrderTotals({ lines: results });

  // Approval check: only meaningful when the actor is a salesman.
  // Admin-created orders (SRS D34) skip the salesman-limit gate since the
  // admin doesn't have a max_discount_pct on the user record.
  let approval: ApprovalCheck;
  if (actor.role === Role.salesman) {
    const salesman = await prisma.user.findUnique({
      where: { id: actor.id },
      select: { maxDiscountPct: true, maxDiscountPkr: true },
    });
    approval = checkSalesmanDiscountLimit(salesman ?? { maxDiscountPct: null, maxDiscountPkr: null }, results);
  } else {
    approval = { requiresApproval: false, maxLinePct: totals.totalDiscountPkr.mul(0), totalPkr: totals.totalDiscountPkr };
  }

  return {
    retailerId,
    lines: wireLines,
    subtotal: totals.subtotal.toString(),
    totalDiscountPkr: totals.totalDiscountPkr.toString(),
    approval: {
      requiresApproval: approval.requiresApproval,
      reason: approval.reason ?? null,
      maxLinePct: approval.maxLinePct.toString(),
      totalPkr: approval.totalPkr.toString(),
    },
  };
}
