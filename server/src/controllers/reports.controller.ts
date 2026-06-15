import type { Request, Response } from 'express';
import { z } from 'zod';
import * as reports from '../services/reports.service';
import { isValidDateKey } from '../lib/businessDay';

function sendCsv(res: Response, filename: string, body: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

// VAL-1: reject a malformed date param with a 400 (ZodError) instead of letting
// an Invalid-Date reach the day-math helpers and surface as a 500.
const dateKey = z.string().refine(isValidDateKey, 'Invalid date; expected YYYY-MM-DD');
function optionalDateKey(value: unknown): string | undefined {
  return typeof value === 'string' ? dateKey.parse(value) : undefined;
}

function range(req: Request) {
  return {
    fromDate: optionalDateKey(req.query.fromDate),
    toDate: optionalDateKey(req.query.toDate),
  };
}

export async function orders(req: Request, res: Response): Promise<void> {
  sendCsv(res, 'orders.csv', await reports.ordersCsv(range(req)));
}
export async function reconciliation(req: Request, res: Response): Promise<void> {
  const date = optionalDateKey(req.query.date);
  sendCsv(res, `reconciliation-${date ?? 'today'}.csv`, await reports.reconciliationCsv(date));
}
export async function stockMovements(req: Request, res: Response): Promise<void> {
  sendCsv(res, 'stock-movements.csv', await reports.stockMovementsCsv(range(req)));
}
export async function posSales(req: Request, res: Response): Promise<void> {
  const date = optionalDateKey(req.query.date);
  sendCsv(res, `pos-sales-${date ?? 'today'}.csv`, await reports.posSalesCsv(date));
}
