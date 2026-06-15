import type { Request, Response } from 'express';
import { z } from 'zod';
import { UnitType } from '@prisma/client';
import { actorFromRequest } from '../lib/audit';
import * as productsService from '../services/products.service';

const idParamSchema = z.object({ id: z.string().uuid() });

const decimalString = z
  .union([z.number(), z.string()])
  .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, {
    message: 'Must be a non-negative number',
  });

const listQuerySchema = z.object({
  search: z.string().trim().min(1).max(80).optional(),
  includeArchived: z.coerce.boolean().optional(),
});

const createSchema = z.object({
  sku: z.string().min(1).max(40).trim(),
  name: z.string().min(1).max(120).trim(),
  category: z.string().max(60).trim().optional().nullable(),
  unitType: z.nativeEnum(UnitType),
  basePrice: decimalString,
  lowStockThreshold: z.number().int().nonnegative().optional(),
});

const updateSchema = z
  .object({
    sku: z.string().min(1).max(40).trim().optional(),
    name: z.string().min(1).max(120).trim().optional(),
    category: z.string().max(60).trim().nullable().optional(),
    unitType: z.nativeEnum(UnitType).optional(),
    basePrice: decimalString.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

export async function list(req: Request, res: Response): Promise<void> {
  const opts = listQuerySchema.parse(req.query);
  const products = await productsService.listProducts(opts);
  res.json({ products });
}

export async function get(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const product = await productsService.getProduct(id);
  res.json({ product });
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = createSchema.parse(req.body);
  const product = await productsService.createProduct(actorFromRequest(req), input);
  res.status(201).json({ product });
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const patch = updateSchema.parse(req.body);
  const product = await productsService.updateProduct(actorFromRequest(req), id, patch);
  res.json({ product });
}

export async function archive(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const product = await productsService.archiveProduct(actorFromRequest(req), id);
  res.json({ product });
}
