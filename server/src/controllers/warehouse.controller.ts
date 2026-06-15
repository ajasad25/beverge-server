import type { Request, Response } from 'express';
import { z } from 'zod';
import { StockMovementType, UnitType } from '@prisma/client';
import { actorFromRequest } from '../lib/audit';
import * as warehouseService from '../services/warehouse.service';

const productIdParam = z.object({ productId: z.string().uuid() });

const listStockQuery = z.object({
  lowStockOnly: z.coerce.boolean().optional(),
  archivedOnly: z.coerce.boolean().optional(),
});

const thresholdSchema = z.object({
  lowStockThreshold: z.number().int().nonnegative(),
});

const adjustSchema = z.object({
  delta: z.number().int().refine((n) => n !== 0, 'delta must be non-zero'),
  reasonCode: z.string().min(1).max(40).trim(),
  note: z.string().max(280).trim().optional(),
});

const listMovementsQuery = z.object({
  productId: z.string().uuid().optional(),
  movementType: z.nativeEnum(StockMovementType).optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

export async function listDrivers(_req: Request, res: Response): Promise<void> {
  res.json(await warehouseService.listDrivers());
}

export async function listStock(req: Request, res: Response): Promise<void> {
  const opts = listStockQuery.parse(req.query);
  const stock = await warehouseService.listStock(opts);
  res.json({ stock });
}

export async function getStock(req: Request, res: Response): Promise<void> {
  const { productId } = productIdParam.parse(req.params);
  const stock = await warehouseService.getStock(productId);
  res.json({ stock });
}

export async function updateThreshold(req: Request, res: Response): Promise<void> {
  const { productId } = productIdParam.parse(req.params);
  const { lowStockThreshold } = thresholdSchema.parse(req.body);
  const stock = await warehouseService.updateThreshold(
    actorFromRequest(req),
    productId,
    lowStockThreshold
  );
  res.json({ stock });
}

export async function adjustStock(req: Request, res: Response): Promise<void> {
  const { productId } = productIdParam.parse(req.params);
  const input = adjustSchema.parse(req.body);
  const result = await warehouseService.adjustStock(actorFromRequest(req), productId, input);
  res.status(201).json(result);
}

export async function listMovements(req: Request, res: Response): Promise<void> {
  const opts = listMovementsQuery.parse(req.query);
  const result = await warehouseService.listMovements(opts);
  res.json(result);
}

export async function valuation(_req: Request, res: Response): Promise<void> {
  res.json(await warehouseService.valuation());
}

const grnSchema = z.object({
  productId: z.string().uuid(),
  unitType: z.nativeEnum(UnitType),
  qtyReceived: z.number().int().positive(),
  supplierRef: z.string().max(80).trim().nullable().optional(),
});

export async function recordGrn(req: Request, res: Response): Promise<void> {
  const input = grnSchema.parse(req.body);
  const result = await warehouseService.recordGrn(actorFromRequest(req), input);
  res.status(201).json(result);
}

export async function listPendingReturns(_req: Request, res: Response): Promise<void> {
  res.json({ returns: await warehouseService.listPendingReturns() });
}

const verifiedReturnsQuery = z.object({
  days: z.coerce.number().int().positive().max(365).optional(),
});

export async function listVerifiedReturns(req: Request, res: Response): Promise<void> {
  const { days } = verifiedReturnsQuery.parse(req.query);
  res.json({ returns: await warehouseService.listVerifiedReturns({ days }) });
}

const verifyReturnsSchema = z.object({
  lines: z
    .array(
      z.object({
        vehicleStockId: z.string().uuid(),
        qtyReturnedVerified: z.number().int().nonnegative(),
      })
    )
    .min(1),
});

export async function verifyReturns(req: Request, res: Response): Promise<void> {
  const { lines } = verifyReturnsSchema.parse(req.body);
  const result = await warehouseService.verifyReturns(actorFromRequest(req), lines);
  res.status(201).json(result);
}

// ─── Start-of-day vehicle loading (admin) ─────────────────────────────────
const loadVehicleSchema = z.object({
  driverId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        unitType: z.nativeEnum(UnitType),
        qty: z.number().int().positive(),
      })
    )
    .min(1)
    .max(200),
});

export async function loadVehicle(req: Request, res: Response): Promise<void> {
  const { driverId, lines } = loadVehicleSchema.parse(req.body);
  const result = await warehouseService.loadVehicle(actorFromRequest(req), driverId, lines);
  res.status(201).json(result);
}

export async function listLoading(_req: Request, res: Response): Promise<void> {
  res.json({ drivers: await warehouseService.listLoadedToday() });
}
