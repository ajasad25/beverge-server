import type { Request, Response } from 'express';
import { z } from 'zod';
import { DiscountType } from '@prisma/client';
import * as pricingService from '../services/pricing.service';

const decimal = z
  .union([z.number(), z.string()])
  .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, 'Must be a non-negative number');

const previewSchema = z.object({
  retailerId: z.string().uuid(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        qty: z.number().int().positive(),
        discountType: z.nativeEnum(DiscountType).optional(),
        discountValue: decimal.optional(),
      })
    )
    .min(1, 'At least one line item is required')
    .max(200),
});

export async function preview(req: Request, res: Response): Promise<void> {
  const input = previewSchema.parse(req.body);
  const result = await pricingService.previewOrder(
    { id: req.auth!.sub, role: req.auth!.role },
    input.retailerId,
    input.items
  );
  res.json(result);
}
