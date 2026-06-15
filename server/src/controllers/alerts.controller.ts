import type { Request, Response } from 'express';
import { z } from 'zod';
import * as alerts from '../services/alerts.service';

export async function list(req: Request, res: Response): Promise<void> {
  const resolved =
    req.query.resolved === 'true' ? true : req.query.resolved === 'false' ? false : undefined;
  res.json({ alerts: await alerts.listAlerts({ resolved }) });
}

export async function recompute(_req: Request, res: Response): Promise<void> {
  res.json(await alerts.recomputeAlerts());
}

const idParam = z.object({ id: z.string().uuid() });

export async function seen(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  await alerts.markSeen(id, req.auth!.sub);
  res.json({ ok: true });
}

export async function resolve(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  await alerts.resolveAlert(id);
  res.json({ ok: true });
}
