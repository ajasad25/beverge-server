import { Prisma, Role, type Language, type PeriodType, type SalesmanTarget, type User, type UserZone } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { hashPin } from '../lib/password';
import { recordAudit, type AuditActor } from '../lib/audit';
import { revokeAllUserRefreshTokens } from './auth.service';
import { HttpError } from '../middleware/error.middleware';

export type PublicUser = Omit<User, 'pinHash'>;

export type CreateUserInput = {
  name: string;
  phone: string;
  role: Role;
  defaultPin: string; // 6 digits; user changes on first login (SM05)
  language?: Language;
  maxDiscountPct?: number | string | null;
  maxDiscountPkr?: number | string | null;
};

export type UpdateUserInput = {
  name?: string;
  phone?: string;
  role?: Role;
  language?: Language;
  maxDiscountPct?: number | string | null;
  maxDiscountPkr?: number | string | null;
  isActive?: boolean;
};

export type ListUsersOpts = {
  role?: Role;
  search?: string;
  // active (default) → only active; inactive → only deactivated; all → both.
  status?: 'active' | 'inactive' | 'all';
};

const FIELD_ROLES: ReadonlyArray<Role> = [Role.salesman, Role.driver];

function stripPin<T extends { pinHash?: string }>(user: T): Omit<T, 'pinHash'> {
  const { pinHash: _ignored, ...rest } = user;
  return rest;
}

// Sales Manager can only create/edit/deactivate salesman + driver per SRS US02.
// Super Admin can manage any role per SRS US01.
function assertActorCanManageTarget(actorRole: Role, targetRole: Role): void {
  if (actorRole === Role.super_admin) return;
  if (actorRole === Role.sales_manager && FIELD_ROLES.includes(targetRole)) return;
  throw new HttpError(
    403,
    'INSUFFICIENT_PRIVILEGE',
    `Role ${actorRole} cannot manage users with role ${targetRole}`
  );
}

export async function listUsers(opts: ListUsersOpts = {}): Promise<PublicUser[]> {
  const where: Prisma.UserWhereInput = {
    isDeleted: false,
    ...(opts.role && { role: opts.role }),
    ...(opts.status === 'all' ? {} : { isActive: opts.status === 'inactive' ? false : true }),
    ...(opts.search && {
      OR: [
        { name: { contains: opts.search, mode: 'insensitive' } },
        { phone: { contains: opts.search } },
      ],
    }),
  };
  const users = await prisma.user.findMany({
    where,
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
  return users.map(stripPin);
}

export async function getUser(id: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || user.isDeleted) {
    throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
  }
  return stripPin(user);
}

export async function createUser(
  actor: AuditActor & { role: Role },
  input: CreateUserInput
): Promise<PublicUser> {
  assertActorCanManageTarget(actor.role, input.role);
  const pinHash = await hashPin(input.defaultPin);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: input.name,
          phone: input.phone,
          role: input.role,
          pinHash,
          language: input.language ?? 'en',
          maxDiscountPct:
            input.maxDiscountPct == null ? null : new Prisma.Decimal(input.maxDiscountPct),
          maxDiscountPkr:
            input.maxDiscountPkr == null ? null : new Prisma.Decimal(input.maxDiscountPkr),
        },
      });
      await recordAudit(
        {
          actor,
          action: 'create',
          entityType: 'user',
          entityId: user.id,
          // Don't log the pin hash
          newValue: stripPin(user),
        },
        tx
      );
      return user;
    });
    return stripPin(created);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'PHONE_TAKEN', 'Another user already uses that phone number');
    }
    throw err;
  }
}

export async function updateUser(
  actor: AuditActor & { role: Role },
  id: string,
  patch: UpdateUserInput
): Promise<PublicUser> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing || existing.isDeleted) {
    throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
  }
  assertActorCanManageTarget(actor.role, existing.role);
  if (patch.role !== undefined && patch.role !== existing.role) {
    // Role escalation: actor must also have the right to manage the new role
    assertActorCanManageTarget(actor.role, patch.role);
  }
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.phone !== undefined && { phone: patch.phone }),
          ...(patch.role !== undefined && { role: patch.role }),
          ...(patch.language !== undefined && { language: patch.language }),
          ...(patch.maxDiscountPct !== undefined && {
            maxDiscountPct:
              patch.maxDiscountPct === null ? null : new Prisma.Decimal(patch.maxDiscountPct),
          }),
          ...(patch.maxDiscountPkr !== undefined && {
            maxDiscountPkr:
              patch.maxDiscountPkr === null ? null : new Prisma.Decimal(patch.maxDiscountPkr),
          }),
          ...(patch.isActive !== undefined && { isActive: patch.isActive }),
        },
      });
      await recordAudit(
        {
          actor,
          action: patch.isActive === false ? 'deactivate' : 'update',
          entityType: 'user',
          entityId: id,
          oldValue: stripPin(existing),
          newValue: stripPin(u),
        },
        tx
      );
      return u;
    });
    return stripPin(updated);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'PHONE_TAKEN', 'Another user already uses that phone number');
    }
    throw err;
  }
}

export async function deactivateUser(
  actor: AuditActor & { role: Role },
  id: string
): Promise<PublicUser> {
  return updateUser(actor, id, { isActive: false });
}

export async function resetUserPin(
  actor: AuditActor & { role: Role },
  id: string,
  newPin: string
): Promise<{ ok: true }> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing || existing.isDeleted) {
    throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
  }
  assertActorCanManageTarget(actor.role, existing.role);
  const pinHash = await hashPin(newPin);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { pinHash } });
    // AUTH-1: an admin reset must end the target's existing sessions too.
    await revokeAllUserRefreshTokens(id, tx);
    await recordAudit(
      {
        actor,
        action: 'reset_pin',
        entityType: 'user',
        entityId: id,
      },
      tx
    );
  });
  return { ok: true };
}

// ─── Salesman targets ────────────────────────────────────────────────────

export type TargetInput = {
  periodType: PeriodType;
  targetOrderValuePkr: number | string;
  targetVisitCount: number;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
};

async function assertIsSalesman(userId: string): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isDeleted: true } });
  if (!u || u.isDeleted) {
    throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
  }
  if (u.role !== Role.salesman) {
    throw new HttpError(400, 'NOT_A_SALESMAN', 'Targets can only be set on salesman users');
  }
}

export async function listTargets(salesmanId: string): Promise<SalesmanTarget[]> {
  return prisma.salesmanTarget.findMany({
    where: { salesmanId },
    orderBy: [{ periodType: 'asc' }, { effectiveFrom: 'desc' }],
  });
}

export async function createTarget(
  actor: AuditActor & { role: Role },
  salesmanId: string,
  input: TargetInput
): Promise<SalesmanTarget> {
  await assertIsSalesman(salesmanId);
  return prisma.$transaction(async (tx) => {
    const t = await tx.salesmanTarget.create({
      data: {
        salesmanId,
        periodType: input.periodType,
        targetOrderValuePkr: new Prisma.Decimal(input.targetOrderValuePkr),
        targetVisitCount: input.targetVisitCount,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
      },
    });
    await recordAudit(
      {
        actor,
        action: 'create',
        entityType: 'salesman_target',
        entityId: t.id,
        newValue: t,
      },
      tx
    );
    return t;
  });
}

export async function deleteTarget(
  actor: AuditActor & { role: Role },
  salesmanId: string,
  targetId: string
): Promise<void> {
  const existing = await prisma.salesmanTarget.findFirst({
    where: { id: targetId, salesmanId },
  });
  if (!existing) {
    throw new HttpError(404, 'TARGET_NOT_FOUND', 'Target not found for this salesman');
  }
  await prisma.$transaction(async (tx) => {
    await tx.salesmanTarget.delete({ where: { id: targetId } });
    await recordAudit(
      {
        actor,
        action: 'delete',
        entityType: 'salesman_target',
        entityId: targetId,
        oldValue: existing,
      },
      tx
    );
  });
}

// ─── Driver zone assignments ─────────────────────────────────────────────

async function assertIsDriver(userId: string): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isDeleted: true } });
  if (!u || u.isDeleted) {
    throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
  }
  if (u.role !== Role.driver) {
    throw new HttpError(400, 'NOT_A_DRIVER', 'Zone assignments only apply to drivers');
  }
}

export async function listUserZones(driverId: string): Promise<UserZone[]> {
  return prisma.userZone.findMany({
    where: { userId: driverId, isActive: true },
    orderBy: { assignedDate: 'desc' },
  });
}

// SRS D8: a driver can cover multiple zones per day if admin assigns.
// Replace the whole assignment set so the caller can pass the desired final state.
export async function setDriverZones(
  actor: AuditActor & { role: Role },
  driverId: string,
  zoneIds: string[]
): Promise<UserZone[]> {
  await assertIsDriver(driverId);
  // Verify all zone IDs exist + active
  if (zoneIds.length > 0) {
    const zoneCount = await prisma.zone.count({
      where: { id: { in: zoneIds }, isActive: true },
    });
    if (zoneCount !== zoneIds.length) {
      throw new HttpError(400, 'INVALID_ZONE_IDS', 'One or more zone IDs are invalid or inactive');
    }
  }
  return prisma.$transaction(async (tx) => {
    const previous = await tx.userZone.findMany({ where: { userId: driverId } });
    // Deactivate existing assignments not in the new set
    await tx.userZone.updateMany({
      where: { userId: driverId, zoneId: { notIn: zoneIds } },
      data: { isActive: false },
    });
    // Upsert each zone assignment
    for (const zoneId of zoneIds) {
      await tx.userZone.upsert({
        where: { userId_zoneId: { userId: driverId, zoneId } },
        update: { isActive: true },
        create: { userId: driverId, zoneId, isActive: true },
      });
    }
    const next = await tx.userZone.findMany({
      where: { userId: driverId, isActive: true },
    });
    await recordAudit(
      {
        actor,
        action: 'set_zones',
        entityType: 'user',
        entityId: driverId,
        oldValue: { zones: previous.filter((p) => p.isActive).map((p) => p.zoneId) },
        newValue: { zones: zoneIds },
      },
      tx
    );
    return next;
  });
}
