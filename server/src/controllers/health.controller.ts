import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';

export function liveness(_req: Request, res: Response): void {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
}

export async function readiness(_req: Request, res: Response): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ status: 'ok', db: 'reachable', timestamp: new Date().toISOString() });
}
