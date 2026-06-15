import type { Request, Response } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../lib/audit';
import { withIdempotency } from '../lib/idempotency';
import * as purchasesService from '../services/purchases.service';

const idemKey = (req: Request) => req.header('Idempotency-Key') ?? undefined;
const idParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  supplierId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

const createSchema = z.object({
  supplierId: z.string().uuid(),
  purchaseDate: z.string().date(),
  supplierRef: z.string().max(80).trim().nullable().optional(),
  farePkr: z.number().nonnegative().optional(),
  discountPkr: z.number().nonnegative().optional(),
  note: z.string().max(200).trim().nullable().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        qtyReceived: z.number().int().positive(),
        unitCostPkr: z.number().nonnegative(),
      })
    )
    .min(1)
    .max(200),
});

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await purchasesService.listPurchases(listQuery.parse(req.query)));
}
export async function get(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  res.json(await purchasesService.getPurchase(id));
}
export async function create(req: Request, res: Response): Promise<void> {
  const input = createSchema.parse(req.body);
  const result = await withIdempotency(idemKey(req), 'purchase.create', () =>
    purchasesService.createPurchase(actorFromRequest(req), input)
  );
  res.status(201).json(result);
}
