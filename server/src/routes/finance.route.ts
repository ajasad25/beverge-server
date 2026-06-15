import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as finance from '../controllers/finance.controller';

export const financeRouter = Router();

// SRS §4.2: Reconcile payments / Outstanding balances — Finance Manager +
// Super Admin only.
financeRouter.use(requireAuth, requireRole(Role.finance_manager, Role.super_admin));

financeRouter.get('/reconciliation', asyncHandler(finance.reconciliation));
financeRouter.post('/reconciliation/mark', asyncHandler(finance.reconcile));
financeRouter.get('/outstanding', asyncHandler(finance.outstanding));
financeRouter.post('/credit-payment', asyncHandler(finance.creditPayment));
financeRouter.get('/retailers/:id/payments', asyncHandler(finance.retailerPayments));
