import type { Request, Response } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../lib/audit';
import * as expensesService from '../services/expenses.service';

const idParam = z.object({ id: z.string().uuid() });

const expenseBody = z.object({
  categoryId: z.string().uuid(),
  amountPkr: z.number().positive(),
  expenseDate: z.string().date(),
  payee: z.string().max(120).trim().nullable().optional(),
  paymentMethod: z.enum(['cash', 'digital', 'cheque', 'credit']),
  referenceNo: z.string().max(80).trim().nullable().optional(),
  note: z.string().max(280).trim().nullable().optional(),
  receiptUrl: z.string().url().max(500).nullable().optional(),
});

const listQuery = z.object({
  categoryId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

export async function listCategories(req: Request, res: Response): Promise<void> {
  const { includeInactive } = z
    .object({ includeInactive: z.coerce.boolean().optional() })
    .parse(req.query);
  res.json(await expensesService.listCategories(includeInactive));
}
export async function createCategory(req: Request, res: Response): Promise<void> {
  const { name } = z.object({ name: z.string().min(1).max(60).trim() }).parse(req.body);
  res.status(201).json(await expensesService.createCategory(actorFromRequest(req), name));
}
export async function updateCategory(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const data = z
    .object({ name: z.string().min(1).max(60).trim().optional(), isActive: z.boolean().optional() })
    .parse(req.body);
  res.json(await expensesService.updateCategory(actorFromRequest(req), id, data));
}
export async function list(req: Request, res: Response): Promise<void> {
  res.json(await expensesService.listExpenses(listQuery.parse(req.query)));
}
export async function create(req: Request, res: Response): Promise<void> {
  res.status(201).json(await expensesService.createExpense(actorFromRequest(req), expenseBody.parse(req.body)));
}
export async function update(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  res.json(await expensesService.updateExpense(actorFromRequest(req), id, expenseBody.partial().parse(req.body)));
}
export async function remove(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  res.json(await expensesService.deleteExpense(actorFromRequest(req), id));
}
export async function summary(req: Request, res: Response): Promise<void> {
  const q = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
  res.json(await expensesService.summary(q));
}
