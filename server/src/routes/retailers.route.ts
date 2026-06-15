import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as retailersController from '../controllers/retailers.controller';

export const retailersRouter = Router();

retailersRouter.use(requireAuth);

// Reads — service applies row-level scoping (salesman sees only own retailers).
// Finance Manager reads for outstanding balance views (SRS §4.2).
const readers = requireRole(
  Role.super_admin,
  Role.sales_manager,
  Role.finance_manager,
  Role.salesman
);
retailersRouter.get('/', readers, asyncHandler(retailersController.list));
retailersRouter.get('/:id', readers, asyncHandler(retailersController.get));
retailersRouter.get('/:id/prices', readers, asyncHandler(retailersController.listPrices));

// Create: salesman registers via mobile (SRS SM12); admins create from web panel.
const creators = requireRole(Role.super_admin, Role.sales_manager, Role.salesman);
retailersRouter.post('/', creators, asyncHandler(retailersController.create));

// Update / approve / status / reassign / special prices — admin only.
const admins = requireRole(Role.super_admin, Role.sales_manager);
retailersRouter.patch('/:id', admins, asyncHandler(retailersController.update));
retailersRouter.post('/:id/approve-credit', admins, asyncHandler(retailersController.approveCredit));
retailersRouter.post('/:id/status', admins, asyncHandler(retailersController.setStatus));
retailersRouter.post('/:id/reassign', admins, asyncHandler(retailersController.reassign));
retailersRouter.put('/:id/prices/:productId', admins, asyncHandler(retailersController.setPrice));
retailersRouter.delete('/:id/prices/:productId', admins, asyncHandler(retailersController.removePrice));
