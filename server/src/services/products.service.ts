import { Prisma, UnitType, type Product } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';

export type ProductInput = {
  sku: string;
  name: string;
  category?: string | null;
  unitType: UnitType;
  basePrice: number | string;
  // Optional: initial warehouse stock threshold (SRS WH07). Defaults to 0.
  lowStockThreshold?: number;
};

export type ProductUpdate = Partial<Omit<ProductInput, 'sku'>> & {
  sku?: string;
  isActive?: boolean;
};

export type ProductWithStock = Product & {
  warehouseStock: { quantityOnHand: number; lowStockThreshold: number } | null;
};

export type ListProductsOpts = {
  search?: string;
  includeArchived?: boolean;
};

export async function listProducts(opts: ListProductsOpts = {}): Promise<ProductWithStock[]> {
  const where: Prisma.ProductWhereInput = {
    isDeleted: false,
    ...(!opts.includeArchived && { isActive: true }),
    ...(opts.search && {
      OR: [
        { name: { contains: opts.search, mode: 'insensitive' } },
        { sku: { contains: opts.search, mode: 'insensitive' } },
      ],
    }),
  };
  return prisma.product.findMany({
    where,
    orderBy: { name: 'asc' },
    include: {
      warehouseStock: { select: { quantityOnHand: true, lowStockThreshold: true } },
    },
  });
}

export async function getProduct(id: string): Promise<ProductWithStock> {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      warehouseStock: { select: { quantityOnHand: true, lowStockThreshold: true } },
    },
  });
  if (!product || product.isDeleted) {
    throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  }
  return product;
}

export async function createProduct(actor: AuditActor, input: ProductInput): Promise<ProductWithStock> {
  try {
    return await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          sku: input.sku,
          name: input.name,
          category: input.category ?? null,
          unitType: input.unitType,
          basePrice: new Prisma.Decimal(input.basePrice),
        },
      });
      // Auto-create the warehouse_stock row so the product is immediately
      // visible in inventory reads, even at zero quantity (SRS WH02).
      await tx.warehouseStock.create({
        data: {
          productId: product.id,
          quantityOnHand: 0,
          lowStockThreshold: input.lowStockThreshold ?? 0,
        },
      });
      await recordAudit(
        {
          actor,
          action: 'create',
          entityType: 'product',
          entityId: product.id,
          newValue: product,
        },
        tx
      );
      return {
        ...product,
        warehouseStock: { quantityOnHand: 0, lowStockThreshold: input.lowStockThreshold ?? 0 },
      };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'PRODUCT_SKU_TAKEN', `SKU "${input.sku}" already exists`);
    }
    throw err;
  }
}

export async function updateProduct(
  actor: AuditActor,
  id: string,
  patch: ProductUpdate
): Promise<ProductWithStock> {
  const existing = await getProduct(id);
  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id },
        data: {
          ...(patch.sku !== undefined && { sku: patch.sku }),
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.category !== undefined && { category: patch.category }),
          ...(patch.unitType !== undefined && { unitType: patch.unitType }),
          ...(patch.basePrice !== undefined && { basePrice: new Prisma.Decimal(patch.basePrice) }),
          ...(patch.isActive !== undefined && { isActive: patch.isActive }),
        },
        include: {
          warehouseStock: { select: { quantityOnHand: true, lowStockThreshold: true } },
        },
      });
      await recordAudit(
        {
          actor,
          action: 'update',
          entityType: 'product',
          entityId: id,
          oldValue: existing,
          newValue: updated,
        },
        tx
      );
      return updated;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'PRODUCT_SKU_TAKEN', 'Another product already uses that SKU');
    }
    throw err;
  }
}

// Soft archive — deactivate but keep the row queryable (isDeleted stays false)
// so an archived product still appears under `includeArchived` and can be
// unarchived from the admin UI. Historical orders/movements stay intact.
export async function archiveProduct(actor: AuditActor, id: string): Promise<ProductWithStock> {
  const existing = await getProduct(id);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.product.update({
      where: { id },
      data: { isActive: false },
      include: {
        warehouseStock: { select: { quantityOnHand: true, lowStockThreshold: true } },
      },
    });
    await recordAudit(
      {
        actor,
        action: 'archive',
        entityType: 'product',
        entityId: id,
        oldValue: existing,
        newValue: updated,
      },
      tx
    );
    return updated;
  });
}
