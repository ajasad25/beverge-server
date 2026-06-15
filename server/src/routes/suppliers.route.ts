import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as suppliersController from '../controllers/suppliers.controller';

// Upstream company account: supplier master + the company ledger (S10).
// Finance-owned — inventory managers receive stock via /purchases instead.
export const suppliersRouter = Router();

suppliersRouter.use(requireAuth);
suppliersRouter.use(requireRole(Role.super_admin, Role.finance_manager));

suppliersRouter.get('/', asyncHandler(suppliersController.list));
suppliersRouter.get('/:id', asyncHandler(suppliersController.get));
suppliersRouter.post('/', asyncHandler(suppliersController.create));
suppliersRouter.patch('/:id', asyncHandler(suppliersController.update));
suppliersRouter.delete('/:id', asyncHandler(suppliersController.remove));

suppliersRouter.get('/:id/ledger', asyncHandler(suppliersController.ledger));
suppliersRouter.post('/:id/ledger', asyncHandler(suppliersController.addEntry));
suppliersRouter.delete('/:id/ledger/:entryId', asyncHandler(suppliersController.deleteEntry));
