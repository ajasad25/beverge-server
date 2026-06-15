import { Prisma, type CompanySettings } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { recordAudit, type AuditActor } from '../lib/audit';

export type SettingsUpdate = {
  name?: string;
  logoUrl?: string | null;
  address?: string | null;
  ntn?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  city?: string;
  currency?: string;
  deliveryRetryLimit?: number;
  alertBalanceThreshold?: number | string;
  idleSalesmanCheckTime?: string;
  zoneFailureThreshold?: number;
  posCashierDiscountLimit?: number | string;
};

// company_settings is a single-row table. The seed creates one row; if it's
// somehow missing (fresh DB without seed) we create it on first read with
// safe defaults so /settings never returns 404.
async function getOrCreateSettings(): Promise<CompanySettings> {
  const existing = await prisma.companySettings.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (existing) return existing;
  return prisma.companySettings.create({
    data: {
      name: 'Unnamed Company',
      city: 'Lahore',
      currency: 'PKR',
    },
  });
}

export async function getSettings(): Promise<CompanySettings> {
  return getOrCreateSettings();
}

export async function updateSettings(
  actor: AuditActor,
  patch: SettingsUpdate
): Promise<CompanySettings> {
  const existing = await getOrCreateSettings();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.companySettings.update({
      where: { id: existing.id },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.logoUrl !== undefined && { logoUrl: patch.logoUrl }),
        ...(patch.address !== undefined && { address: patch.address }),
        ...(patch.ntn !== undefined && { ntn: patch.ntn }),
        ...(patch.contactPhone !== undefined && { contactPhone: patch.contactPhone }),
        ...(patch.contactEmail !== undefined && { contactEmail: patch.contactEmail }),
        ...(patch.city !== undefined && { city: patch.city }),
        ...(patch.currency !== undefined && { currency: patch.currency }),
        ...(patch.deliveryRetryLimit !== undefined && {
          deliveryRetryLimit: patch.deliveryRetryLimit,
        }),
        ...(patch.alertBalanceThreshold !== undefined && {
          alertBalanceThreshold: new Prisma.Decimal(patch.alertBalanceThreshold),
        }),
        ...(patch.idleSalesmanCheckTime !== undefined && {
          idleSalesmanCheckTime: patch.idleSalesmanCheckTime,
        }),
        ...(patch.zoneFailureThreshold !== undefined && {
          zoneFailureThreshold: patch.zoneFailureThreshold,
        }),
        ...(patch.posCashierDiscountLimit !== undefined && {
          posCashierDiscountLimit: new Prisma.Decimal(patch.posCashierDiscountLimit),
        }),
        updatedBy: actor.id,
      },
    });
    await recordAudit(
      {
        actor,
        action: 'update',
        entityType: 'company_settings',
        entityId: existing.id,
        oldValue: existing,
        newValue: updated,
      },
      tx
    );
    return updated;
  });
}
