import type { Request, Response } from 'express';
import { z } from 'zod';
import { DeliveryStatus, PaymentMethod, UnitType } from '@prisma/client';
import { actorFromRequest } from '../lib/audit';
import { withIdempotency } from '../lib/idempotency';
import * as driver from '../services/driver.service';

function actor(req: Request) {
  return { ...actorFromRequest(req), role: req.auth!.role };
}

const idemKey = (req: Request) => req.header('Idempotency-Key') ?? undefined;

const idParam = z.object({ id: z.string().uuid() });
const decimal = z
  .union([z.number(), z.string()])
  .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, 'Must be a non-negative number');

export async function snapshot(req: Request, res: Response): Promise<void> {
  res.json(await driver.buildDriverSnapshot(req.auth!.sub));
}

// shiftDate: the local business day (YYYY-MM-DD) the driver performed the
// action on, so an action drained after midnight still targets the right shift.
const shiftDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'shiftDate must be YYYY-MM-DD')
  .optional();

const loadingSchema = z.object({
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        unitType: z.nativeEnum(UnitType),
        qty: z.number().int().positive(),
      })
    )
    .min(1),
  shiftDate: shiftDateField,
});

export async function loading(req: Request, res: Response): Promise<void> {
  const { lines, shiftDate } = loadingSchema.parse(req.body);
  const a = actor(req);
  res
    .status(201)
    .json(
      await withIdempotency(idemKey(req), 'driver.loading', () =>
        driver.confirmLoading(a, lines, shiftDate)
      )
    );
}

const deliverSchema = z.object({
  status: z.nativeEnum(DeliveryStatus),
  reasonCode: z.string().max(60).trim().nullable().optional(),
  photoUrl: z.string().url().nullable().optional(),
  gpsLat: z.number().min(-90).max(90).nullable().optional(),
  gpsLng: z.number().min(-180).max(180).nullable().optional(),
  deliveredItems: z
    .array(z.object({ productId: z.string().uuid(), qtyDelivered: z.number().int().nonnegative() }))
    .optional(),
  confirmedAt: z.string().datetime().optional(),
});

export async function deliver(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const input = deliverSchema.parse(req.body);
  const a = actor(req);
  res.json(
    await withIdempotency(idemKey(req), 'driver.deliver', () =>
      driver.confirmDelivery(a, id, input)
    )
  );
}

const paymentSchema = z.object({
  amountPkr: decimal,
  method: z.nativeEnum(PaymentMethod),
  referenceNo: z.string().max(80).trim().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
});

export async function payment(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const input = paymentSchema.parse(req.body);
  const a = actor(req);
  res
    .status(201)
    .json(
      await withIdempotency(idemKey(req), 'driver.payment', () =>
        driver.recordPayment(a, id, input)
      )
    );
}

const presignSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png']),
});

export async function proofUploadUrl(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const { contentType } = presignSchema.parse(req.body);
  res.json(await driver.presignProofUpload(actor(req), id, contentType));
}

const attachProofSchema = z.object({ key: z.string().min(1).max(300) });

export async function attachProof(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const { key } = attachProofSchema.parse(req.body);
  res.json(await driver.attachProofPhoto(actor(req), id, key));
}

const eodSchema = z.object({
  returns: z.array(
    z.object({
      productId: z.string().uuid(),
      unitType: z.nativeEnum(UnitType),
      qtyReturned: z.number().int().nonnegative(),
    })
  ),
  cashHandoverPkr: decimal,
  shiftDate: shiftDateField,
});

export async function eod(req: Request, res: Response): Promise<void> {
  const { returns, cashHandoverPkr, shiftDate } = eodSchema.parse(req.body);
  const a = actor(req);
  res
    .status(201)
    .json(
      await withIdempotency(idemKey(req), 'driver.eod', () =>
        driver.submitEod(a, returns, cashHandoverPkr, shiftDate)
      )
    );
}
