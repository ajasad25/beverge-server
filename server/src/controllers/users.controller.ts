import type { Request, Response } from 'express';
import { z } from 'zod';
import { Language, PeriodType, Role } from '@prisma/client';
import { actorFromRequest } from '../lib/audit';
import { pinPolicyError } from '../lib/pinPolicy';
import * as usersService from '../services/users.service';

const idParamSchema = z.object({ id: z.string().uuid() });

const decimalString = z
  .union([z.number(), z.string()])
  // Reject empty/whitespace strings: Number('') === 0 would pass the numeric
  // check but then new Prisma.Decimal('') throws an unhandled 500. The UI sends
  // null/undefined for "no value", never '', so this only closes a raw-API gap.
  .refine(
    (v) => String(v).trim() !== '' && !Number.isNaN(Number(v)) && Number(v) >= 0,
    'Must be a non-negative number'
  );

// A discount percent is logically 0..100 (the pricing floor caps it anyway), and
// max_discount_pct is NUMERIC(5,2) — an unbounded value like 9000 overflows the
// column (Postgres 22003). The API is the real guard, so bound it here.
const percentString = z
  .union([z.number(), z.string()])
  .refine(
    (v) => String(v).trim() !== '' && !Number.isNaN(Number(v)) && Number(v) >= 0 && Number(v) <= 100,
    'Max discount % must be between 0 and 100'
  );

// AUTH-3: the admin-set initial PIN and admin reset reject trivially weak PINs
// (no oldPin to compare against on these paths).
const pinSchema = z
  .string()
  .regex(/^\d{6}$/, 'PIN must be exactly 6 digits')
  .refine((p) => pinPolicyError(p) === null, 'PIN is too easy to guess; avoid repeated digits or simple sequences');

const listQuerySchema = z.object({
  role: z.nativeEnum(Role).optional(),
  search: z.string().trim().min(1).max(80).optional(),
  // active (default) → only active; inactive → only deactivated; all → both.
  status: z.enum(['active', 'inactive', 'all']).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  phone: z.string().min(7).max(20).trim(),
  role: z.nativeEnum(Role),
  defaultPin: pinSchema,
  language: z.nativeEnum(Language).optional(),
  maxDiscountPct: percentString.nullable().optional(),
  maxDiscountPkr: decimalString.nullable().optional(),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(120).trim().optional(),
    phone: z.string().min(7).max(20).trim().optional(),
    role: z.nativeEnum(Role).optional(),
    language: z.nativeEnum(Language).optional(),
    maxDiscountPct: percentString.nullable().optional(),
    maxDiscountPkr: decimalString.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), 'At least one field required');

const resetPinSchema = z.object({ newPin: pinSchema });

const targetIdParams = z.object({ id: z.string().uuid(), targetId: z.string().uuid() });
const targetInputSchema = z.object({
  periodType: z.nativeEnum(PeriodType),
  targetOrderValuePkr: decimalString,
  targetVisitCount: z.number().int().nonnegative(),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullable().optional(),
});

const setZonesSchema = z.object({
  zoneIds: z.array(z.string().uuid()).max(20),
});

function actorWithRole(req: Request) {
  return { ...actorFromRequest(req), role: req.auth!.role };
}

export async function list(req: Request, res: Response): Promise<void> {
  const opts = listQuerySchema.parse(req.query);
  const users = await usersService.listUsers(opts);
  res.json({ users });
}

export async function get(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const user = await usersService.getUser(id);
  res.json({ user });
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = createSchema.parse(req.body);
  const user = await usersService.createUser(actorWithRole(req), input);
  res.status(201).json({ user });
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const patch = updateSchema.parse(req.body);
  const user = await usersService.updateUser(actorWithRole(req), id, patch);
  res.json({ user });
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const user = await usersService.deactivateUser(actorWithRole(req), id);
  res.json({ user });
}

export async function resetPin(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const { newPin } = resetPinSchema.parse(req.body);
  await usersService.resetUserPin(actorWithRole(req), id, newPin);
  res.json({ ok: true });
}

export async function listTargets(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const targets = await usersService.listTargets(id);
  res.json({ targets });
}

export async function createTarget(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const input = targetInputSchema.parse(req.body);
  const target = await usersService.createTarget(actorWithRole(req), id, input);
  res.status(201).json({ target });
}

export async function deleteTarget(req: Request, res: Response): Promise<void> {
  const { id, targetId } = targetIdParams.parse(req.params);
  await usersService.deleteTarget(actorWithRole(req), id, targetId);
  res.status(204).end();
}

export async function listZones(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const zones = await usersService.listUserZones(id);
  res.json({ zones });
}

export async function setZones(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const { zoneIds } = setZonesSchema.parse(req.body);
  const zones = await usersService.setDriverZones(actorWithRole(req), id, zoneIds);
  res.json({ zones });
}
