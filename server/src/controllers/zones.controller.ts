import type { Request, Response } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../lib/audit';
import * as zonesService from '../services/zones.service';

const idParamSchema = z.object({ id: z.string().uuid('Zone id must be a UUID') });

const listQuerySchema = z.object({
  includeInactive: z.coerce.boolean().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(80).trim(),
  city: z.string().min(1).max(80).trim(),
  description: z.string().max(280).trim().optional().nullable(),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(80).trim().optional(),
    city: z.string().min(1).max(80).trim().optional(),
    description: z.string().max(280).trim().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

export async function list(req: Request, res: Response): Promise<void> {
  const { includeInactive } = listQuerySchema.parse(req.query);
  const zones = await zonesService.listZones({ includeInactive });
  res.json({ zones });
}

export async function get(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const zone = await zonesService.getZone(id);
  res.json({ zone });
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = createSchema.parse(req.body);
  const zone = await zonesService.createZone(actorFromRequest(req), input);
  res.status(201).json({ zone });
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const patch = updateSchema.parse(req.body);
  const zone = await zonesService.updateZone(actorFromRequest(req), id, patch);
  res.json({ zone });
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const zone = await zonesService.deactivateZone(actorFromRequest(req), id);
  res.json({ zone });
}
