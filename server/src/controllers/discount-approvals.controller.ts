import type { Request, Response } from 'express';
import { z } from 'zod';
import { DiscountApprovalStatus } from '@prisma/client';
import { actorFromRequest } from '../lib/audit';
import * as approvalsService from '../services/discount-approvals.service';

const idParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  status: z.nativeEnum(DiscountApprovalStatus).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(1).max(400).trim(),
});

export async function list(req: Request, res: Response): Promise<void> {
  const opts = listQuery.parse(req.query);
  // Default to pending if the caller didn't specify — that's the approval-queue use case
  const result = await approvalsService.listApprovals({
    ...opts,
    status: opts.status ?? DiscountApprovalStatus.pending,
  });
  res.json(result);
}

export async function approve(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const approval = await approvalsService.approveDiscount(actorFromRequest(req), id);
  res.json({ approval });
}

export async function reject(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const { reason } = rejectSchema.parse(req.body);
  const approval = await approvalsService.rejectDiscount(actorFromRequest(req), id, reason);
  res.json({ approval });
}
