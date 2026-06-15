import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as alerts from '../controllers/alerts.controller';

export const alertsRouter = Router();

alertsRouter.use(requireAuth);

// §9.6 alerts surface to the admin tier (which exact roles see which alert
// is a UI concern; the badge filters client-side). Read + mark-seen for all
// admin roles; recompute/resolve are Super Admin (the cron also recomputes).
const adminTier = requireRole(
  Role.super_admin,
  Role.sales_manager,
  Role.inventory_manager,
  Role.finance_manager
);
alertsRouter.get('/', adminTier, asyncHandler(alerts.list));
alertsRouter.post('/:id/seen', adminTier, asyncHandler(alerts.seen));
alertsRouter.post('/recompute', requireRole(Role.super_admin), asyncHandler(alerts.recompute));
alertsRouter.post('/:id/resolve', requireRole(Role.super_admin), asyncHandler(alerts.resolve));
