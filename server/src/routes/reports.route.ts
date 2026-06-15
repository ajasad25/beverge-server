import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as reports from '../controllers/reports.controller';

export const reportsRouter = Router();

reportsRouter.use(requireAuth);

// SRS §17.3 Reports Centre access: Admin (all), Sales Mgr (sales),
// Finance Mgr (finance), Inv. Mgr (stock).
reportsRouter.get(
  '/orders.csv',
  requireRole(Role.super_admin, Role.sales_manager),
  asyncHandler(reports.orders)
);
reportsRouter.get(
  '/reconciliation.csv',
  requireRole(Role.super_admin, Role.finance_manager),
  asyncHandler(reports.reconciliation)
);
reportsRouter.get(
  '/stock-movements.csv',
  requireRole(Role.super_admin, Role.inventory_manager),
  asyncHandler(reports.stockMovements)
);
reportsRouter.get(
  '/pos-sales.csv',
  requireRole(Role.super_admin, Role.finance_manager),
  asyncHandler(reports.posSales)
);
