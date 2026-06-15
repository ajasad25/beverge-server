import type { Request, Response } from 'express';
import { z } from 'zod';
import * as analytics from '../services/analytics.service';
import { recomputeRetailerHealth } from '../services/retailer-health.service';

const periodSchema = z.enum(['day', 'week', 'month']).catch('day');

function period(req: Request): analytics.Period {
  return periodSchema.parse(req.query.period);
}

export async function superAdmin(req: Request, res: Response): Promise<void> {
  res.json(await analytics.superAdmin(period(req)));
}
export async function salesManager(req: Request, res: Response): Promise<void> {
  res.json(await analytics.salesManager(period(req)));
}
export async function inventory(_req: Request, res: Response): Promise<void> {
  res.json(await analytics.inventory());
}
export async function finance(req: Request, res: Response): Promise<void> {
  res.json(await analytics.finance(period(req)));
}
export async function recomputeHealth(_req: Request, res: Response): Promise<void> {
  res.json(await recomputeRetailerHealth());
}
