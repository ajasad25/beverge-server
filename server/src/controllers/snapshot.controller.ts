import type { Request, Response } from 'express';
import { buildSalesmanSnapshot } from '../services/snapshot.service';

export async function getSalesmanSnapshot(req: Request, res: Response): Promise<void> {
  // requireAuth guarantees req.auth; route restricts to the salesman role.
  const snapshot = await buildSalesmanSnapshot(req.auth!.sub);
  res.json(snapshot);
}
