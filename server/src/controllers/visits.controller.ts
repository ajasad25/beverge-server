import type { Request, Response } from 'express';
import { z } from 'zod';
import { VisitType } from '@prisma/client';
import { actorFromRequest } from '../lib/audit';
import { withIdempotency } from '../lib/idempotency';
import * as visitsService from '../services/visits.service';

const createSchema = z.object({
  retailerId: z.string().uuid(),
  visitType: z.nativeEnum(VisitType),
  orderId: z.string().uuid().nullable().optional(),
  note: z.string().max(280).trim().nullable().optional(),
  visitedAt: z.string().datetime().optional(),
});

export async function create(req: Request, res: Response): Promise<void> {
  const input = createSchema.parse(req.body);
  const actor = { ...actorFromRequest(req), role: req.auth!.role };
  const visit = await withIdempotency(
    req.header('Idempotency-Key') ?? undefined,
    'visit.create',
    () => visitsService.createVisit(actor, input)
  );
  res.status(201).json({ visit });
}
