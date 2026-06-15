import type { Request, Response } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../lib/audit';
import * as settingsService from '../services/settings.service';

const decimal = z
  .union([z.number(), z.string()])
  .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, 'Must be a non-negative number');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM (24-hour)');

const updateSchema = z
  .object({
    name: z.string().min(1).max(160).trim().optional(),
    logoUrl: z.string().url().nullable().optional(),
    address: z.string().max(400).trim().nullable().optional(),
    ntn: z.string().max(40).trim().nullable().optional(),
    contactPhone: z.string().max(40).trim().nullable().optional(),
    contactEmail: z.string().email().nullable().optional(),
    city: z.string().min(1).max(80).trim().optional(),
    currency: z.string().length(3).optional(),
    deliveryRetryLimit: z.number().int().min(0).max(10).optional(),
    alertBalanceThreshold: decimal.optional(),
    idleSalesmanCheckTime: hhmm.optional(),
    zoneFailureThreshold: z.number().int().min(1).max(50).optional(),
    posCashierDiscountLimit: decimal.optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), 'At least one field required');

export async function get(_req: Request, res: Response): Promise<void> {
  const settings = await settingsService.getSettings();
  res.json({ settings });
}

export async function update(req: Request, res: Response): Promise<void> {
  const patch = updateSchema.parse(req.body);
  const settings = await settingsService.updateSettings(actorFromRequest(req), patch);
  res.json({ settings });
}
