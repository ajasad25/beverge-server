import type { Request, Response } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../lib/audit';
import { isValidDateKey } from '../lib/businessDay';
import * as finance from '../services/finance.service';

function actor(req: Request) {
  return { ...actorFromRequest(req), role: req.auth!.role };
}

// VAL-1: a malformed ?date= returns 400 instead of a 500 from day-math.
const dateKey = z.string().refine(isValidDateKey, 'Invalid date; expected YYYY-MM-DD');

export async function reconciliation(req: Request, res: Response): Promise<void> {
  const date = typeof req.query.date === 'string' ? dateKey.parse(req.query.date) : undefined;
  res.json(await finance.dailyReconciliation(date));
}

const reconcileSchema = z.object({
  driverId: z.string().uuid(),
  date: z.string().optional(),
});
export async function reconcile(req: Request, res: Response): Promise<void> {
  const { driverId, date } = reconcileSchema.parse(req.body);
  res.json(await finance.markDriverReconciled(actor(req), driverId, date));
}

export async function outstanding(_req: Request, res: Response): Promise<void> {
  res.json(await finance.outstandingAgeing());
}

const creditSchema = z.object({
  retailerId: z.string().uuid(),
  // Strict money: reject NaN/Infinity/non-numeric/<=0 with a clean 400 instead
  // of letting bad input reach `new Prisma.Decimal(...)` and throw an
  // unhandled 500 (which, in non-prod, also leaks the raw error).
  amountPkr: z
    .union([z.number(), z.string()])
    .refine(
      (v) => Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 1e12,
      'Amount must be a positive number'
    ),
});
export async function creditPayment(req: Request, res: Response): Promise<void> {
  const { retailerId, amountPkr } = creditSchema.parse(req.body);
  res.status(201).json(await finance.recordCreditPayment(actor(req), retailerId, amountPkr));
}

const retailerIdParam = z.object({ id: z.string().uuid() });
export async function retailerPayments(req: Request, res: Response): Promise<void> {
  const { id } = retailerIdParam.parse(req.params);
  res.json(await finance.retailerPaymentHistory(id));
}
