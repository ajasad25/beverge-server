import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as analytics from '../controllers/analytics.controller';

export const analyticsRouter = Router();

analyticsRouter.use(requireAuth);

// Each role sees its own tailored dashboard (SRS §10.1-10.4, D29).
// Super Admin can view any.
analyticsRouter.get(
  '/super-admin',
  requireRole(Role.super_admin),
  asyncHandler(analytics.superAdmin)
);
analyticsRouter.get(
  '/sales-manager',
  requireRole(Role.super_admin, Role.sales_manager),
  asyncHandler(analytics.salesManager)
);
analyticsRouter.get(
  '/inventory',
  requireRole(Role.super_admin, Role.inventory_manager),
  asyncHandler(analytics.inventory)
);
analyticsRouter.get(
  '/finance',
  requireRole(Role.super_admin, Role.finance_manager),
  asyncHandler(analytics.finance)
);

// Retailer health is recalculated nightly by cron (§10.6); this is the
// manual "run now" for Super Admin / Sales Manager.
analyticsRouter.post(
  '/health/recompute',
  requireRole(Role.super_admin, Role.sales_manager),
  asyncHandler(analytics.recomputeHealth)
);
