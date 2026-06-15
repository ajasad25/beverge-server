import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as approvalsController from '../controllers/discount-approvals.controller';

export const discountApprovalsRouter = Router();

// Admin only — SRS D13 + §4.2 "Approve discount" YES for super_admin and
// sales_manager, NO for everyone else.
discountApprovalsRouter.use(requireAuth);
discountApprovalsRouter.use(requireRole(Role.super_admin, Role.sales_manager));

discountApprovalsRouter.get('/', asyncHandler(approvalsController.list));
discountApprovalsRouter.post('/:id/approve', asyncHandler(approvalsController.approve));
discountApprovalsRouter.post('/:id/reject', asyncHandler(approvalsController.reject));
