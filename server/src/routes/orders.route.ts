import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as ordersController from '../controllers/orders.controller';

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

// Reads — service applies row-scoping (salesman/driver see only their own).
// All admin roles + finance + field roles can list/get with appropriate scope.
const readers = requireRole(
  Role.super_admin,
  Role.sales_manager,
  Role.finance_manager,
  Role.salesman,
  Role.driver
);
ordersRouter.get('/', readers, asyncHandler(ordersController.list));
ordersRouter.get('/:id', readers, asyncHandler(ordersController.get));

// Create — salesman from mobile, super_admin + sales_manager via manual entry (D34).
const creators = requireRole(Role.salesman, Role.super_admin, Role.sales_manager);
ordersRouter.post('/', creators, asyncHandler(ordersController.create));

// Edit — same role set; the service enforces the "PENDING/PENDING_APPROVAL
// only" and "salesman cannot edit past midnight" rules.
ordersRouter.patch('/:id', creators, asyncHandler(ordersController.update));

// Assign — super_admin + sales_manager (SRS §4.2 "Assign order to driver").
const assignAdmins = requireRole(Role.super_admin, Role.sales_manager);
ordersRouter.post('/:id/assign', assignAdmins, asyncHandler(ordersController.assign));
ordersRouter.post('/assign', assignAdmins, asyncHandler(ordersController.assignBatch));

// Cancel — Super Admin only (SRS §3.3, D33).
ordersRouter.post('/:id/cancel', requireRole(Role.super_admin), asyncHandler(ordersController.cancel));
