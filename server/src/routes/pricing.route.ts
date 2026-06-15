import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as pricingController from '../controllers/pricing.controller';

export const pricingRouter = Router();

pricingRouter.use(requireAuth);

// Pricing preview is callable by anyone who can build an order:
// salesman (their own retailers — scoped in service), super_admin, and
// sales_manager (manual order creation per SRS D34).
pricingRouter.post(
  '/preview',
  requireRole(Role.salesman, Role.super_admin, Role.sales_manager),
  asyncHandler(pricingController.preview)
);
