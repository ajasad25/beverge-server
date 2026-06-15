import { Prisma, ExpensePaymentMethod } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';
import { summarizeExpenses } from '../lib/expense-summary';

const num = (d: Prisma.Decimal) => Number(d);

export async function listCategories(includeInactive = false) {
  const categories = await prisma.expenseCategory.findMany({
    where: { isDeleted: false, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: { name: 'asc' },
  });
  return { categories };
}

export async function createCategory(actor: AuditActor, name: string) {
  const existing = await prisma.expenseCategory.findUnique({ where: { name } });
  if (existing && !existing.isDeleted) {
    throw new HttpError(409, 'CATEGORY_EXISTS', 'Category already exists');
  }
  const category = existing
    ? await prisma.expenseCategory.update({ where: { id: existing.id }, data: { isDeleted: false, isActive: true } })
    : await prisma.expenseCategory.create({ data: { name } });
  await recordAudit(
    { actor, action: 'create', entityType: 'expense_category', entityId: category.id, newValue: category },
    prisma
  );
  return { category };
}

export async function updateCategory(
  actor: AuditActor,
  id: string,
  data: { name?: string; isActive?: boolean }
) {
  const existing = await prisma.expenseCategory.findFirst({ where: { id, isDeleted: false } });
  if (!existing) throw new HttpError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
  const category = await prisma.expenseCategory.update({ where: { id }, data });
  await recordAudit(
    { actor, action: 'update', entityType: 'expense_category', entityId: id, oldValue: existing, newValue: category },
    prisma
  );
  return { category };
}

export type ExpenseInput = {
  categoryId: string;
  amountPkr: number;
  expenseDate: string;
  payee?: string | null;
  paymentMethod: 'cash' | 'digital' | 'cheque' | 'credit';
  referenceNo?: string | null;
  note?: string | null;
  receiptUrl?: string | null;
};

export async function listExpenses(
  opts: { categoryId?: string; from?: Date; to?: Date; page?: number; pageSize?: number } = {}
) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const where: Prisma.ExpenseWhereInput = {
    isDeleted: false,
    ...(opts.categoryId && { categoryId: opts.categoryId }),
    ...((opts.from || opts.to) && {
      expenseDate: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) },
    }),
  };
  const [rows, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: { expenseDate: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { category: { select: { name: true } } },
    }),
    prisma.expense.count({ where }),
  ]);
  const expenses = rows.map((e) => ({
    id: e.id,
    categoryId: e.categoryId,
    categoryName: e.category.name,
    amountPkr: num(e.amountPkr),
    expenseDate: e.expenseDate.toISOString().slice(0, 10),
    payee: e.payee,
    paymentMethod: e.paymentMethod,
    referenceNo: e.referenceNo,
    note: e.note,
    receiptUrl: e.receiptUrl,
  }));
  return { expenses, total, page, pageSize };
}

export async function createExpense(actor: AuditActor, input: ExpenseInput) {
  if (input.amountPkr <= 0) throw new HttpError(400, 'INVALID_AMOUNT', 'Amount must be positive');
  const cat = await prisma.expenseCategory.findFirst({ where: { id: input.categoryId, isDeleted: false } });
  if (!cat) throw new HttpError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
  const expense = await prisma.expense.create({
    data: {
      categoryId: input.categoryId,
      amountPkr: input.amountPkr,
      expenseDate: new Date(input.expenseDate),
      payee: input.payee ?? null,
      paymentMethod: input.paymentMethod as ExpensePaymentMethod,
      referenceNo: input.referenceNo ?? null,
      note: input.note ?? null,
      receiptUrl: input.receiptUrl ?? null,
      createdBy: actor.id,
    },
  });
  await recordAudit(
    { actor, action: 'create', entityType: 'expense', entityId: expense.id, newValue: expense },
    prisma
  );
  return { expense };
}

export async function updateExpense(actor: AuditActor, id: string, input: Partial<ExpenseInput>) {
  const existing = await prisma.expense.findFirst({ where: { id, isDeleted: false } });
  if (!existing) throw new HttpError(404, 'EXPENSE_NOT_FOUND', 'Expense not found');
  const expense = await prisma.expense.update({
    where: { id },
    data: {
      ...(input.categoryId && { categoryId: input.categoryId }),
      ...(input.amountPkr != null && { amountPkr: input.amountPkr }),
      ...(input.expenseDate && { expenseDate: new Date(input.expenseDate) }),
      ...(input.payee !== undefined && { payee: input.payee }),
      ...(input.paymentMethod && { paymentMethod: input.paymentMethod as ExpensePaymentMethod }),
      ...(input.referenceNo !== undefined && { referenceNo: input.referenceNo }),
      ...(input.note !== undefined && { note: input.note }),
      ...(input.receiptUrl !== undefined && { receiptUrl: input.receiptUrl }),
    },
  });
  await recordAudit(
    { actor, action: 'update', entityType: 'expense', entityId: id, oldValue: existing, newValue: expense },
    prisma
  );
  return { expense };
}

export async function deleteExpense(actor: AuditActor, id: string) {
  const existing = await prisma.expense.findFirst({ where: { id, isDeleted: false } });
  if (!existing) throw new HttpError(404, 'EXPENSE_NOT_FOUND', 'Expense not found');
  await prisma.expense.update({ where: { id }, data: { isDeleted: true } });
  await recordAudit(
    { actor, action: 'delete', entityType: 'expense', entityId: id, oldValue: existing },
    prisma
  );
  return { ok: true };
}

export async function summary(opts: { from?: Date; to?: Date } = {}) {
  const where: Prisma.ExpenseWhereInput = {
    isDeleted: false,
    ...((opts.from || opts.to) && {
      expenseDate: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) },
    }),
  };
  const rows = await prisma.expense.findMany({ where, include: { category: { select: { name: true } } } });
  return summarizeExpenses(
    rows.map((e) => ({
      categoryId: e.categoryId,
      categoryName: e.category.name,
      amountPkr: num(e.amountPkr),
      expenseDate: e.expenseDate.toISOString().slice(0, 10),
    }))
  );
}
