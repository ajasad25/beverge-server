import type { Request, Response } from 'express';
import { z } from 'zod';
import { DiscountType, OrderStatus } from '@prisma/client';
import { actorFromRequest } from '../lib/audit';
import { withIdempotency } from '../lib/idempotency';
import * as ordersService from '../services/orders.service';

const idemKey = (req: Request) => req.header('Idempotency-Key') ?? undefined;

const idParam = z.object({ id: z.string().uuid() });

const decimal = z
  .union([z.number(), z.string()])
  .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, 'Must be a non-negative number');

const itemInput = z.object({
  productId: z.string().uuid(),
  qty: z.number().int().positive(),
  discountType: z.nativeEnum(DiscountType).optional(),
  discountValue: decimal.optional(),
  // PRICE-1 / SRS §5.1: the unit price the offline app showed the salesman. Used
  // only to flag a sync-time price revision — never to charge (server recomputes).
  capturedUnitPrice: decimal.optional(),
});

const createSchema = z.object({
  retailerId: z.string().uuid(),
  items: z.array(itemInput).min(1).max(200),
  note: z.string().max(200).trim().optional(),
  salesmanId: z.string().uuid().optional(),
  // Device capture time from the offline app, so order_date reflects when the
  // order was placed rather than when it synced (see createOrder).
  capturedAt: z.string().datetime().optional(),
});

const updateSchema = z
  .object({
    note: z.string().max(200).trim().nullable().optional(),
    items: z.array(itemInput).min(1).max(200).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), 'At least one field required');

const listQuery = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  search: z.string().trim().min(1).max(80).optional(),
  zoneId: z.string().uuid().optional(),
  salesmanId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
  retailerId: z.string().uuid().optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

function actorWithRole(req: Request) {
  return { ...actorFromRequest(req), role: req.auth!.role };
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = createSchema.parse(req.body);
  const a = actorWithRole(req);
  const order = await withIdempotency(idemKey(req), 'order.create', () =>
    ordersService.createOrder(a, input)
  );
  res.status(201).json({ order });
}

export async function list(req: Request, res: Response): Promise<void> {
  const opts = listQuery.parse(req.query);
  const result = await ordersService.listOrders(actorWithRole(req), opts);
  res.json(result);
}

export async function get(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const order = await ordersService.getOrder(actorWithRole(req), id);
  res.json({ order });
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const patch = updateSchema.parse(req.body);
  const a = actorWithRole(req);
  const order = await withIdempotency(idemKey(req), 'order.update', () =>
    ordersService.updateOrder(a, id, patch)
  );
  res.json({ order });
}

const assignSchema = z.object({ driverId: z.string().uuid() });

export async function assign(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const { driverId } = assignSchema.parse(req.body);
  const order = await ordersService.assignOrder(actorWithRole(req), id, driverId);
  res.json({ order });
}

const assignBatchSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(200),
  driverId: z.string().uuid(),
});

export async function assignBatch(req: Request, res: Response): Promise<void> {
  const { orderIds, driverId } = assignBatchSchema.parse(req.body);
  const result = await ordersService.assignOrdersBatch(actorWithRole(req), orderIds, driverId);
  res.json(result);
}

const cancelSchema = z.object({ reason: z.string().min(1).max(400).trim() });

export async function cancel(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const { reason } = cancelSchema.parse(req.body);
  const order = await ordersService.cancelOrder(actorWithRole(req), id, reason);
  res.json({ order });
}
