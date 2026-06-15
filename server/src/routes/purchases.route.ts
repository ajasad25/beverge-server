import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as purchasesController from '../controllers/purchases.controller';

// Receiving stock from the principal company. Creating a purchase is an
// inventory action (it increments warehouse stock) that also posts the
// company ledger; finance may view but not create. (S10)
export const purchasesRouter = Router();
purchasesRouter.use(requireAuth);

const readers = requireRole(Role.super_admin, Role.inventory_manager, Role.finance_manager);
const writers = requireRole(Role.super_admin, Role.inventory_manager);

purchasesRouter.get('/', readers, asyncHandler(purchasesController.list));
purchasesRouter.get('/:id', readers, asyncHandler(purchasesController.get));
purchasesRouter.post('/', writers, asyncHandler(purchasesController.create));
