import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as expensesController from '../controllers/expenses.controller';

// Operating expenses + categories (S10). Finance-owned.
export const expensesRouter = Router();
expensesRouter.use(requireAuth);
expensesRouter.use(requireRole(Role.super_admin, Role.finance_manager));

// Static sub-paths declared before /:id so they aren't captured by the param.
expensesRouter.get('/categories', asyncHandler(expensesController.listCategories));
expensesRouter.post('/categories', asyncHandler(expensesController.createCategory));
expensesRouter.patch('/categories/:id', asyncHandler(expensesController.updateCategory));

expensesRouter.get('/summary', asyncHandler(expensesController.summary));
expensesRouter.get('/', asyncHandler(expensesController.list));
expensesRouter.post('/', asyncHandler(expensesController.create));
expensesRouter.patch('/:id', asyncHandler(expensesController.update));
expensesRouter.delete('/:id', asyncHandler(expensesController.remove));
