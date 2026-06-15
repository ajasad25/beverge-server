import {
  Prisma,
  Role,
  type HealthState,
  type Retailer,
  type RetailerPrice,
  type RetailerStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';

export type Actor = AuditActor & { role: Role };

export type CreateRetailerInput = {
  shopName: string;
  ownerName: string;
  phone: string;
  gpsLat?: number | null;
  gpsLng?: number | null;
  zoneId: string;
  // Optional: when admin creates. Salesman creates always force-set to self.
  primarySalesmanId?: string;
  // Salesman recommends; admin approves separately (SRS D2)
  creditLimit?: number | string;
  overdueThresholdDays?: number | null;
};

export type UpdateRetailerInput = {
  shopName?: string;
  ownerName?: string;
  phone?: string;
  gpsLat?: number;
  gpsLng?: number;
  zoneId?: string;
  overdueThresholdDays?: number | null;
};

export type ListRetailersOpts = {
  zoneId?: string;
  salesmanId?: string;
  status?: RetailerStatus;
  healthState?: HealthState;
  search?: string;
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
};

// Salesman scope: only retailers where actor IS the primary salesman.
function applyActorScope(
  where: Prisma.RetailerWhereInput,
  actor: Actor
): Prisma.RetailerWhereInput {
  if (actor.role === Role.salesman) {
    return { ...where, primarySalesmanId: actor.id };
  }
  return where;
}

async function ensureSalesman(userId: string): Promise<void> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, isDeleted: true, isActive: true },
  });
  if (!u || u.isDeleted || !u.isActive || u.role !== Role.salesman) {
    throw new HttpError(400, 'INVALID_SALESMAN', 'primarySalesmanId must reference an active salesman');
  }
}

async function ensureZone(zoneId: string): Promise<void> {
  const z = await prisma.zone.findUnique({ where: { id: zoneId }, select: { isActive: true } });
  if (!z || !z.isActive) {
    throw new HttpError(400, 'INVALID_ZONE', 'zoneId must reference an active zone');
  }
}

export async function listRetailers(
  actor: Actor,
  opts: ListRetailersOpts = {}
): Promise<{ retailers: Retailer[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const where: Prisma.RetailerWhereInput = applyActorScope(
    {
      isDeleted: false,
      ...(opts.zoneId && { zoneId: opts.zoneId }),
      ...(opts.salesmanId && { primarySalesmanId: opts.salesmanId }),
      ...(opts.status && { status: opts.status }),
      ...(opts.healthState && { healthState: opts.healthState }),
      ...(!opts.includeInactive && { status: { not: 'inactive' } }),
      ...(opts.search && {
        OR: [
          { shopName: { contains: opts.search, mode: 'insensitive' } },
          { ownerName: { contains: opts.search, mode: 'insensitive' } },
          { phone: { contains: opts.search } },
        ],
      }),
    },
    actor
  );
  const [retailers, total] = await Promise.all([
    prisma.retailer.findMany({
      where,
      orderBy: { shopName: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.retailer.count({ where }),
  ]);
  return { retailers, total, page, pageSize };
}

export async function getRetailer(actor: Actor, id: string): Promise<Retailer> {
  const where = applyActorScope({ id, isDeleted: false }, actor);
  const retailer = await prisma.retailer.findFirst({ where });
  if (!retailer) {
    throw new HttpError(404, 'RETAILER_NOT_FOUND', 'Retailer not found');
  }
  return retailer;
}

export async function createRetailer(actor: Actor, input: CreateRetailerInput): Promise<Retailer> {
  // Salesman creates always assign to self regardless of payload (SRS §4.2)
  const primarySalesmanId =
    actor.role === Role.salesman ? actor.id : input.primarySalesmanId;
  if (!primarySalesmanId) {
    throw new HttpError(400, 'PRIMARY_SALESMAN_REQUIRED', 'primarySalesmanId is required');
  }
  await Promise.all([ensureZone(input.zoneId), ensureSalesman(primarySalesmanId)]);

  return prisma.$transaction(async (tx) => {
    const retailer = await tx.retailer.create({
      data: {
        shopName: input.shopName,
        ownerName: input.ownerName,
        phone: input.phone,
        gpsLat: input.gpsLat != null ? new Prisma.Decimal(input.gpsLat) : null,
        gpsLng: input.gpsLng != null ? new Prisma.Decimal(input.gpsLng) : null,
        zoneId: input.zoneId,
        primarySalesmanId,
        creditLimit: new Prisma.Decimal(input.creditLimit ?? 0),
        // creditLimitApproved defaults to false; admin approves separately (SRS D2)
        overdueThresholdDays: input.overdueThresholdDays ?? null,
      },
    });
    await recordAudit(
      {
        actor,
        action: 'create',
        entityType: 'retailer',
        entityId: retailer.id,
        newValue: retailer,
      },
      tx
    );
    return retailer;
  });
}

export async function updateRetailer(
  actor: Actor,
  id: string,
  patch: UpdateRetailerInput
): Promise<Retailer> {
  const existing = await getRetailer(actor, id);
  if (patch.zoneId !== undefined) {
    await ensureZone(patch.zoneId);
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.retailer.update({
      where: { id },
      data: {
        ...(patch.shopName !== undefined && { shopName: patch.shopName }),
        ...(patch.ownerName !== undefined && { ownerName: patch.ownerName }),
        ...(patch.phone !== undefined && { phone: patch.phone }),
        ...(patch.gpsLat !== undefined && { gpsLat: new Prisma.Decimal(patch.gpsLat) }),
        ...(patch.gpsLng !== undefined && { gpsLng: new Prisma.Decimal(patch.gpsLng) }),
        ...(patch.zoneId !== undefined && { zoneId: patch.zoneId }),
        ...(patch.overdueThresholdDays !== undefined && {
          overdueThresholdDays: patch.overdueThresholdDays,
        }),
      },
    });
    await recordAudit(
      {
        actor,
        action: 'update',
        entityType: 'retailer',
        entityId: id,
        oldValue: existing,
        newValue: updated,
      },
      tx
    );
    return updated;
  });
}

// Admin approves or modifies the salesman-recommended credit limit (SRS RT02).
export async function approveCreditLimit(
  actor: Actor,
  id: string,
  creditLimit: number | string
): Promise<Retailer> {
  const existing = await prisma.retailer.findUnique({ where: { id } });
  if (!existing || existing.isDeleted) {
    throw new HttpError(404, 'RETAILER_NOT_FOUND', 'Retailer not found');
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.retailer.update({
      where: { id },
      data: {
        creditLimit: new Prisma.Decimal(creditLimit),
        creditLimitApproved: true,
        creditLimitApprovedBy: actor.id,
      },
    });
    await recordAudit(
      {
        actor,
        action: 'approve_credit',
        entityType: 'retailer',
        entityId: id,
        oldValue: { creditLimit: existing.creditLimit, creditLimitApproved: existing.creditLimitApproved },
        newValue: { creditLimit, creditLimitApproved: true },
      },
      tx
    );
    return updated;
  });
}

export async function setRetailerStatus(
  actor: Actor,
  id: string,
  status: RetailerStatus
): Promise<Retailer> {
  const existing = await prisma.retailer.findUnique({ where: { id } });
  if (!existing || existing.isDeleted) {
    throw new HttpError(404, 'RETAILER_NOT_FOUND', 'Retailer not found');
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.retailer.update({ where: { id }, data: { status } });
    await recordAudit(
      {
        actor,
        action: `status_${status}`,
        entityType: 'retailer',
        entityId: id,
        oldValue: { status: existing.status },
        newValue: { status },
      },
      tx
    );
    return updated;
  });
}

// Reassign primary salesman — SRS D7 (admin can reassign anytime).
export async function reassignSalesman(
  actor: Actor,
  id: string,
  newSalesmanId: string
): Promise<Retailer> {
  await ensureSalesman(newSalesmanId);
  const existing = await prisma.retailer.findUnique({ where: { id } });
  if (!existing || existing.isDeleted) {
    throw new HttpError(404, 'RETAILER_NOT_FOUND', 'Retailer not found');
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.retailer.update({
      where: { id },
      data: { primarySalesmanId: newSalesmanId },
    });
    await recordAudit(
      {
        actor,
        action: 'reassign_salesman',
        entityType: 'retailer',
        entityId: id,
        oldValue: { primarySalesmanId: existing.primarySalesmanId },
        newValue: { primarySalesmanId: newSalesmanId },
      },
      tx
    );
    return updated;
  });
}

// ─── Per-retailer special prices (SRS §11, RT03) ─────────────────────────

export async function listSpecialPrices(actor: Actor, retailerId: string): Promise<RetailerPrice[]> {
  // Reuse getRetailer to enforce salesman scope before listing
  await getRetailer(actor, retailerId);
  return prisma.retailerPrice.findMany({
    where: { retailerId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function setSpecialPrice(
  actor: Actor,
  retailerId: string,
  productId: string,
  specialPrice: number | string
): Promise<RetailerPrice> {
  await getRetailer(actor, retailerId);
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { isDeleted: true, basePrice: true },
  });
  if (!product || product.isDeleted) {
    throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  }
  return prisma.$transaction(async (tx) => {
    const previous = await tx.retailerPrice.findUnique({
      where: { retailerId_productId: { retailerId, productId } },
    });
    const row = await tx.retailerPrice.upsert({
      where: { retailerId_productId: { retailerId, productId } },
      update: { specialPrice: new Prisma.Decimal(specialPrice), setBy: actor.id },
      create: {
        retailerId,
        productId,
        specialPrice: new Prisma.Decimal(specialPrice),
        setBy: actor.id,
      },
    });
    await recordAudit(
      {
        actor,
        action: previous ? 'update' : 'create',
        entityType: 'retailer_price',
        entityId: row.id,
        oldValue: previous ?? undefined,
        newValue: row,
      },
      tx
    );
    return row;
  });
}

export async function removeSpecialPrice(
  actor: Actor,
  retailerId: string,
  productId: string
): Promise<void> {
  await getRetailer(actor, retailerId);
  const existing = await prisma.retailerPrice.findUnique({
    where: { retailerId_productId: { retailerId, productId } },
  });
  if (!existing) {
    throw new HttpError(404, 'SPECIAL_PRICE_NOT_FOUND', 'No special price set for this product');
  }
  await prisma.$transaction(async (tx) => {
    await tx.retailerPrice.delete({
      where: { retailerId_productId: { retailerId, productId } },
    });
    await recordAudit(
      {
        actor,
        action: 'delete',
        entityType: 'retailer_price',
        entityId: existing.id,
        oldValue: existing,
      },
      tx
    );
  });
}
