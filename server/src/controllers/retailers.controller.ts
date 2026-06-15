import type { Request, Response } from 'express';
import { z } from 'zod';
import { HealthState, RetailerStatus } from '@prisma/client';
import { actorFromRequest } from '../lib/audit';
import { withIdempotency } from '../lib/idempotency';
import * as retailersService from '../services/retailers.service';

const idemKey = (req: Request) => req.header('Idempotency-Key') ?? undefined;

const idParam = z.object({ id: z.string().uuid() });
const idAndProductParam = z.object({ id: z.string().uuid(), productId: z.string().uuid() });

const decimal = z
  .union([z.number(), z.string()])
  .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, 'Must be a non-negative number');

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

const listQuery = z.object({
  zoneId: z.string().uuid().optional(),
  salesmanId: z.string().uuid().optional(),
  status: z.nativeEnum(RetailerStatus).optional(),
  healthState: z.nativeEnum(HealthState).optional(),
  search: z.string().trim().min(1).max(80).optional(),
  includeInactive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

const bothOrNeitherGps = (d: { gpsLat?: number; gpsLng?: number }) =>
  (d.gpsLat == null) === (d.gpsLng == null);

const createSchema = z
  .object({
    shopName: z.string().min(1).max(160).trim(),
    ownerName: z.string().min(1).max(120).trim(),
    phone: z.string().min(7).max(20).trim(),
    // GPS optional for web-admin creation (no map picker). Mobile still sends it.
    gpsLat: lat.optional(),
    gpsLng: lng.optional(),
    zoneId: z.string().uuid(),
    primarySalesmanId: z.string().uuid().optional(),
    creditLimit: decimal.optional(),
    overdueThresholdDays: z.number().int().positive().nullable().optional(),
  })
  .refine(bothOrNeitherGps, {
    message: 'gpsLat and gpsLng must be provided together',
    path: ['gpsLat'],
  });

const updateSchema = z
  .object({
    shopName: z.string().min(1).max(160).trim().optional(),
    ownerName: z.string().min(1).max(120).trim().optional(),
    phone: z.string().min(7).max(20).trim().optional(),
    gpsLat: lat.optional(),
    gpsLng: lng.optional(),
    zoneId: z.string().uuid().optional(),
    overdueThresholdDays: z.number().int().positive().nullable().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), 'At least one field required')
  .refine(bothOrNeitherGps, {
    message: 'gpsLat and gpsLng must be provided together',
    path: ['gpsLat'],
  });

const approveCreditSchema = z.object({ creditLimit: decimal });
const statusSchema = z.object({ status: z.nativeEnum(RetailerStatus) });
const reassignSchema = z.object({ salesmanId: z.string().uuid() });
const setPriceSchema = z.object({ specialPrice: decimal });

function actorWithRole(req: Request) {
  return { ...actorFromRequest(req), role: req.auth!.role };
}

export async function list(req: Request, res: Response): Promise<void> {
  const opts = listQuery.parse(req.query);
  const result = await retailersService.listRetailers(actorWithRole(req), opts);
  res.json(result);
}

export async function get(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const retailer = await retailersService.getRetailer(actorWithRole(req), id);
  res.json({ retailer });
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = createSchema.parse(req.body);
  const a = actorWithRole(req);
  const retailer = await withIdempotency(idemKey(req), 'retailer.create', () =>
    retailersService.createRetailer(a, input)
  );
  res.status(201).json({ retailer });
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const patch = updateSchema.parse(req.body);
  const retailer = await retailersService.updateRetailer(actorWithRole(req), id, patch);
  res.json({ retailer });
}

export async function approveCredit(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const { creditLimit } = approveCreditSchema.parse(req.body);
  const retailer = await retailersService.approveCreditLimit(actorWithRole(req), id, creditLimit);
  res.json({ retailer });
}

export async function setStatus(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const { status } = statusSchema.parse(req.body);
  const retailer = await retailersService.setRetailerStatus(actorWithRole(req), id, status);
  res.json({ retailer });
}

export async function reassign(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const { salesmanId } = reassignSchema.parse(req.body);
  const retailer = await retailersService.reassignSalesman(actorWithRole(req), id, salesmanId);
  res.json({ retailer });
}

export async function listPrices(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const prices = await retailersService.listSpecialPrices(actorWithRole(req), id);
  res.json({ prices });
}

export async function setPrice(req: Request, res: Response): Promise<void> {
  const { id, productId } = idAndProductParam.parse(req.params);
  const { specialPrice } = setPriceSchema.parse(req.body);
  const price = await retailersService.setSpecialPrice(actorWithRole(req), id, productId, specialPrice);
  res.json({ price });
}

export async function removePrice(req: Request, res: Response): Promise<void> {
  const { id, productId } = idAndProductParam.parse(req.params);
  await retailersService.removeSpecialPrice(actorWithRole(req), id, productId);
  res.status(204).end();
}
