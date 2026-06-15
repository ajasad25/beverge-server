import { Prisma, LedgerDirection, LedgerEntryType, IncentivePeriod } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';
import {
  directionForType,
  runningBalance,
  round2,
  summarizeLedger,
  type LedgerDir,
  type LedgerType,
} from '../lib/ledger';

const num = (d: Prisma.Decimal) => Number(d);

export async function listSuppliers(includeInactive = false) {
  const suppliers = await prisma.supplier.findMany({
    where: { isDeleted: false, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: { name: 'asc' },
  });
  // Current ledger balance per supplier (positive = we owe; negative = advance
  // held). The purchase page shows Available Balance = −balance. One grouped
  // query rather than a ledger fetch per supplier.
  const grouped = await prisma.supplierLedgerEntry.groupBy({
    by: ['supplierId', 'direction'],
    where: { isDeleted: false, supplierId: { in: suppliers.map((s) => s.id) } },
    _sum: { amountPkr: true },
  });
  const balance = new Map<string, number>();
  for (const g of grouped) {
    const amt = num(g._sum.amountPkr ?? new Prisma.Decimal(0));
    const signed = g.direction === LedgerDirection.debit ? amt : -amt;
    balance.set(g.supplierId, round2((balance.get(g.supplierId) ?? 0) + signed));
  }
  return { suppliers: suppliers.map((s) => ({ ...s, balancePkr: balance.get(s.id) ?? 0 })) };
}

export async function getSupplier(id: string) {
  const supplier = await prisma.supplier.findFirst({ where: { id, isDeleted: false } });
  if (!supplier) throw new HttpError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
  return { supplier };
}

export type CreateSupplierInput = {
  name: string;
  contactPhone?: string | null;
  address?: string | null;
  ntn?: string | null;
  openingBalancePkr?: number; // > 0 => debit (we owe), < 0 => credit (advance)
  openingBalanceDate?: string; // ISO date
};

export async function createSupplier(actor: AuditActor, input: CreateSupplierInput) {
  return prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.create({
      data: {
        name: input.name,
        contactPhone: input.contactPhone ?? null,
        address: input.address ?? null,
        ntn: input.ntn ?? null,
      },
    });
    if (input.openingBalancePkr && input.openingBalancePkr !== 0) {
      const direction: LedgerDir = input.openingBalancePkr > 0 ? 'debit' : 'credit';
      await tx.supplierLedgerEntry.create({
        data: {
          supplierId: supplier.id,
          entryType: LedgerEntryType.opening_balance,
          direction: direction as LedgerDirection,
          amountPkr: Math.abs(input.openingBalancePkr),
          entryDate: input.openingBalanceDate ? new Date(input.openingBalanceDate) : new Date(),
          createdBy: actor.id,
        },
      });
    }
    await recordAudit(
      { actor, action: 'create', entityType: 'supplier', entityId: supplier.id, newValue: supplier },
      tx
    );
    return { supplier };
  });
}

export type UpdateSupplierInput = Partial<
  Pick<CreateSupplierInput, 'name' | 'contactPhone' | 'address' | 'ntn'>
> & {
  isActive?: boolean;
};

export async function updateSupplier(actor: AuditActor, id: string, input: UpdateSupplierInput) {
  const existing = await prisma.supplier.findFirst({ where: { id, isDeleted: false } });
  if (!existing) throw new HttpError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
  const supplier = await prisma.supplier.update({ where: { id }, data: input });
  await recordAudit(
    { actor, action: 'update', entityType: 'supplier', entityId: id, oldValue: existing, newValue: supplier },
    prisma
  );
  return { supplier };
}

export async function deleteSupplier(actor: AuditActor, id: string) {
  const existing = await prisma.supplier.findFirst({ where: { id, isDeleted: false } });
  if (!existing) throw new HttpError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
  await prisma.supplier.update({ where: { id }, data: { isDeleted: true, isActive: false } });
  await recordAudit(
    { actor, action: 'delete', entityType: 'supplier', entityId: id, oldValue: existing },
    prisma
  );
  return { ok: true };
}

export type LedgerQuery = { from?: Date; to?: Date; type?: LedgerEntryType };

export async function getLedger(supplierId: string, q: LedgerQuery = {}) {
  const { supplier } = await getSupplier(supplierId);
  const where: Prisma.SupplierLedgerEntryWhereInput = {
    supplierId,
    isDeleted: false,
    ...(q.type && { entryType: q.type }),
    ...((q.from || q.to) && {
      entryDate: { ...(q.from && { gte: q.from }), ...(q.to && { lte: q.to }) },
    }),
  };
  const rows = await prisma.supplierLedgerEntry.findMany({
    where,
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
    include: { purchase: { select: { purchaseNumber: true } } },
  });
  const balances = runningBalance(
    rows.map((r) => ({ direction: r.direction as LedgerDir, amountPkr: num(r.amountPkr) }))
  );
  const entries = rows.map((r, i) => ({
    id: r.id,
    entryType: r.entryType,
    direction: r.direction,
    amountPkr: num(r.amountPkr),
    entryDate: r.entryDate.toISOString().slice(0, 10),
    referenceNo: r.referenceNo,
    incentivePeriod: r.incentivePeriod,
    periodLabel: r.periodLabel,
    note: r.note,
    purchaseId: r.purchaseId,
    purchaseNumber: r.purchase?.purchaseNumber ?? null,
    runningBalancePkr: balances[i],
    createdAt: r.createdAt.toISOString(),
  }));
  // Summary over the WHOLE supplier history (not just the filtered window).
  const allRows = await prisma.supplierLedgerEntry.findMany({
    where: { supplierId, isDeleted: false },
    select: { entryType: true, direction: true, amountPkr: true },
  });
  const summary = summarizeLedger(
    allRows.map((r) => ({
      entryType: r.entryType as LedgerType,
      direction: r.direction as LedgerDir,
      amountPkr: num(r.amountPkr),
    }))
  );
  return { supplier, entries, summary };
}

export type ManualEntryInput = {
  entryType: 'funds_paid' | 'incentive' | 'discount' | 'fare' | 'adjustment' | 'opening_balance';
  amountPkr: number;
  entryDate: string;
  direction?: LedgerDir; // required for adjustment/opening_balance
  referenceNo?: string | null;
  incentivePeriod?: 'monthly' | 'quarterly' | 'annual';
  periodLabel?: string | null;
  note?: string | null;
};

export async function addManualEntry(actor: AuditActor, supplierId: string, input: ManualEntryInput) {
  await getSupplier(supplierId);
  if (input.amountPkr <= 0) throw new HttpError(400, 'INVALID_AMOUNT', 'Amount must be positive');
  if (input.entryType === 'incentive' && !input.incentivePeriod) {
    throw new HttpError(400, 'PERIOD_REQUIRED', 'Incentive period is required for incentive entries');
  }
  const direction = directionForType(input.entryType as LedgerType, input.direction);
  const entry = await prisma.supplierLedgerEntry.create({
    data: {
      supplierId,
      entryType: input.entryType as LedgerEntryType,
      direction: direction as LedgerDirection,
      amountPkr: input.amountPkr,
      entryDate: new Date(input.entryDate),
      referenceNo: input.referenceNo ?? null,
      incentivePeriod: (input.incentivePeriod as IncentivePeriod) ?? null,
      periodLabel: input.periodLabel ?? null,
      note: input.note ?? null,
      createdBy: actor.id,
    },
  });
  await recordAudit(
    { actor, action: 'create', entityType: 'supplier_ledger_entry', entityId: entry.id, newValue: entry },
    prisma
  );
  return { entry };
}

export async function deleteLedgerEntry(actor: AuditActor, supplierId: string, entryId: string) {
  const entry = await prisma.supplierLedgerEntry.findFirst({
    where: { id: entryId, supplierId, isDeleted: false },
  });
  if (!entry) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Ledger entry not found');
  if (entry.purchaseId) {
    throw new HttpError(
      409,
      'PURCHASE_ENTRY_LOCKED',
      'Entries posted by a purchase cannot be deleted; record an adjustment instead'
    );
  }
  await prisma.supplierLedgerEntry.update({ where: { id: entryId }, data: { isDeleted: true } });
  await recordAudit(
    { actor, action: 'delete', entityType: 'supplier_ledger_entry', entityId: entryId, oldValue: entry },
    prisma
  );
  return { ok: true };
}
