import { Prisma, type Zone } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';

export type ZoneInput = {
  name: string;
  city: string;
  description?: string | null;
};

export type ZoneUpdate = Partial<ZoneInput> & { isActive?: boolean };

export async function listZones(opts: { includeInactive?: boolean } = {}): Promise<Zone[]> {
  return prisma.zone.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: [{ city: 'asc' }, { name: 'asc' }],
  });
}

export async function getZone(id: string): Promise<Zone> {
  const zone = await prisma.zone.findUnique({ where: { id } });
  if (!zone) {
    throw new HttpError(404, 'ZONE_NOT_FOUND', 'Zone not found');
  }
  return zone;
}

export async function createZone(actor: AuditActor, input: ZoneInput): Promise<Zone> {
  try {
    return await prisma.$transaction(async (tx) => {
      const zone = await tx.zone.create({
        data: { name: input.name, city: input.city, description: input.description ?? null },
      });
      await recordAudit(
        {
          actor,
          action: 'create',
          entityType: 'zone',
          entityId: zone.id,
          newValue: zone,
        },
        tx
      );
      return zone;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'ZONE_ALREADY_EXISTS', `Zone "${input.name}" in ${input.city} already exists`);
    }
    throw err;
  }
}

export async function updateZone(actor: AuditActor, id: string, patch: ZoneUpdate): Promise<Zone> {
  const existing = await getZone(id);
  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.zone.update({
        where: { id },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.city !== undefined && { city: patch.city }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.isActive !== undefined && { isActive: patch.isActive }),
        },
      });
      await recordAudit(
        {
          actor,
          action: 'update',
          entityType: 'zone',
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
      throw new HttpError(409, 'ZONE_ALREADY_EXISTS', 'Another zone with that name already exists in this city');
    }
    throw err;
  }
}

// Soft delete: zones are referenced by retailers and orders, so we deactivate
// rather than removing the row (SRS §12 intro: soft delete only on business records)
export async function deactivateZone(actor: AuditActor, id: string): Promise<Zone> {
  return updateZone(actor, id, { isActive: false });
}
