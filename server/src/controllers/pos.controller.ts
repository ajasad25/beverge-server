import type { Request, Response } from 'express';
import { z } from 'zod';
import { POSPaymentMethod } from '@prisma/client';
import { actorFromRequest } from '../lib/audit';
import { withIdempotency } from '../lib/idempotency';
import { isValidDateKey } from '../lib/businessDay';
import * as pos from '../services/pos.service';

function actor(req: Request) {
  return { ...actorFromRequest(req), role: req.auth!.role };
}

// VAL-1: a malformed ?date= returns 400 instead of a 500 from day-math.
const dateKey = z.string().refine(isValidDateKey, 'Invalid date; expected YYYY-MM-DD');
function optionalDateKey(value: unknown): string | undefined {
  return typeof value === 'string' ? dateKey.parse(value) : undefined;
}

const decimal = z
  .union([z.number(), z.string()])
  .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, 'Must be a non-negative number');

const createSchema = z.object({
  items: z.array(z.object({ productId: z.string().uuid(), qty: z.number().int().positive() })).min(1),
  discountPkr: decimal.optional(),
  paymentMethod: z.nativeEnum(POSPaymentMethod),
  referenceNo: z.string().max(80).trim().nullable().optional(),
  cashReceived: decimal.optional(),
});

export async function createSale(req: Request, res: Response): Promise<void> {
  const input = createSchema.parse(req.body);
  const a = actor(req);
  // POS confirm can be retried by a flaky cashier network; dedupe so a
  // double-tap doesn't double-deduct stock (§16 idempotency).
  const result = await withIdempotency(
    req.header('Idempotency-Key') ?? undefined,
    'pos.sale',
    () => pos.createSale(a, input)
  );
  res.status(201).json(result);
}

const idParam = z.object({ id: z.string().uuid() });

export async function voidSale(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  res.json({ sale: await pos.voidSale(actor(req), id) });
}

const listQuery = z.object({
  date: z.string().optional(),
  cashierId: z.string().uuid().optional(),
});

export async function listSales(req: Request, res: Response): Promise<void> {
  const opts = listQuery.parse(req.query);
  // A pos_cashier may only ever see their OWN sales — force the scope and
  // ignore any client-supplied cashierId (otherwise it's a horizontal IDOR:
  // one cashier reading another's full sales/revenue history). Super Admin and
  // Finance Manager may pass an arbitrary cashierId.
  if (req.auth!.role === 'pos_cashier') opts.cashierId = req.auth!.sub;
  res.json({ sales: await pos.listSales(opts) });
}

export async function getSale(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  // Scope a single-receipt fetch to the owning cashier for pos_cashier so they
  // can't read an arbitrary sale by id; admins/finance can read any.
  const scopeCashierId = req.auth!.role === 'pos_cashier' ? req.auth!.sub : undefined;
  res.json(await pos.getSale(id, scopeCashierId));
}

export async function dailySummary(req: Request, res: Response): Promise<void> {
  const date = optionalDateKey(req.query.date);
  // A pos_cashier's summary covers only their own sales so the cards match
  // their (already self-scoped) sales list and they can't read company-wide
  // POS revenue. Super Admin / Finance see the whole till.
  const scopeCashierId = req.auth!.role === 'pos_cashier' ? req.auth!.sub : undefined;
  res.json(await pos.dailySummary(date, scopeCashierId));
}
