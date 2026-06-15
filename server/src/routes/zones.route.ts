import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as zonesController from '../controllers/zones.controller';

export const zonesRouter = Router();

// All zone reads available to any authenticated user (mobile apps need the
// zone catalog for retailer registration; admins need it for dashboards).
zonesRouter.use(requireAuth);
zonesRouter.get('/', asyncHandler(zonesController.list));
zonesRouter.get('/:id', asyncHandler(zonesController.get));

// Mutations: Super Admin + Sales Manager only (SRS D1, §9.7).
const adminOnly = requireRole(Role.super_admin, Role.sales_manager);
zonesRouter.post('/', adminOnly, asyncHandler(zonesController.create));
zonesRouter.patch('/:id', adminOnly, asyncHandler(zonesController.update));
zonesRouter.delete('/:id', adminOnly, asyncHandler(zonesController.deactivate));
