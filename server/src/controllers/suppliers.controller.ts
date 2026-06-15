import type { Request, Response } from 'express';
import { z } from 'zod';
import { LedgerEntryType } from '@prisma/client';
import { actorFromRequest } from '../lib/audit';
import * as suppliersService from '../services/suppliers.service';

const idParam = z.object({ id: z.string().uuid() });
const ledgerEntryIdParam = z.object({ id: z.string().uuid(), entryId: z.string().uuid() });

const createSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  contactPhone: z.string().max(40).trim().nullable().optional(),
  address: z.string().max(280).trim().nullable().optional(),
  ntn: z.string().max(40).trim().nullable().optional(),
  openingBalancePkr: z.number().optional(),
  openingBalanceDate: z.string().date().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).trim().optional(),
  contactPhone: z.string().max(40).trim().nullable().optional(),
  address: z.string().max(280).trim().nullable().optional(),
  ntn: z.string().max(40).trim().nullable().optional(),
  isActive: z.boolean().optional(),
});

const ledgerQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  type: z.nativeEnum(LedgerEntryType).optional(),
});

const manualEntrySchema = z
  .object({
    entryType: z.enum(['funds_paid', 'incentive', 'discount', 'fare', 'adjustment', 'opening_balance']),
    amountPkr: z.number().positive(),
    entryDate: z.string().date(),
    direction: z.enum(['debit', 'credit']).optional(),
    referenceNo: z.string().max(80).trim().nullable().optional(),
    incentivePeriod: z.enum(['monthly', 'quarterly', 'annual']).optional(),
    periodLabel: z.string().max(40).trim().nullable().optional(),
    note: z.string().max(280).trim().nullable().optional(),
  })
  .refine((v) => !['adjustment', 'opening_balance'].includes(v.entryType) || !!v.direction, {
    message: 'direction is required for adjustment/opening_balance',
    path: ['direction'],
  });

export async function list(req: Request, res: Response): Promise<void> {
  const includeInactive = req.query.includeInactive === 'true';
  res.json(await suppliersService.listSuppliers(includeInactive));
}
export async function get(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  res.json(await suppliersService.getSupplier(id));
}
export async function create(req: Request, res: Response): Promise<void> {
  const input = createSchema.parse(req.body);
  res.status(201).json(await suppliersService.createSupplier(actorFromRequest(req), input));
}
export async function update(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const input = updateSchema.parse(req.body);
  res.json(await suppliersService.updateSupplier(actorFromRequest(req), id, input));
}
export async function remove(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  res.json(await suppliersService.deleteSupplier(actorFromRequest(req), id));
}
export async function ledger(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const q = ledgerQuery.parse(req.query);
  res.json(await suppliersService.getLedger(id, q));
}
export async function addEntry(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const input = manualEntrySchema.parse(req.body);
  res.status(201).json(await suppliersService.addManualEntry(actorFromRequest(req), id, input));
}
export async function deleteEntry(req: Request, res: Response): Promise<void> {
  const { id, entryId } = ledgerEntryIdParam.parse(req.params);
  res.json(await suppliersService.deleteLedgerEntry(actorFromRequest(req), id, entryId));
}
