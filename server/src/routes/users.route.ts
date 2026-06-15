import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as usersController from '../controllers/users.controller';

export const usersRouter = Router();

usersRouter.use(requireAuth);

// Reads available to both admin roles; the service layer enforces no extra
// scoping since admin-tier roles see all users.
const adminReader = requireRole(Role.super_admin, Role.sales_manager);
usersRouter.get('/', adminReader, asyncHandler(usersController.list));
usersRouter.get('/:id', adminReader, asyncHandler(usersController.get));

// Mutations gated to the same two roles at the route layer; the service
// further restricts what each role can do (Sales Manager → salesman+driver
// only, SRS US01/US02). That second check lives in the service so the rule
// holds even if a route ever bypasses the role guard.
const adminMutator = requireRole(Role.super_admin, Role.sales_manager);
usersRouter.post('/', adminMutator, asyncHandler(usersController.create));
usersRouter.patch('/:id', adminMutator, asyncHandler(usersController.update));
usersRouter.delete('/:id', adminMutator, asyncHandler(usersController.deactivate));
usersRouter.post('/:id/reset-pin', adminMutator, asyncHandler(usersController.resetPin));

// Salesman targets
usersRouter.get('/:id/targets', adminReader, asyncHandler(usersController.listTargets));
usersRouter.post('/:id/targets', adminMutator, asyncHandler(usersController.createTarget));
usersRouter.delete('/:id/targets/:targetId', adminMutator, asyncHandler(usersController.deleteTarget));

// Driver zone assignments
usersRouter.get('/:id/zones', adminReader, asyncHandler(usersController.listZones));
usersRouter.put('/:id/zones', adminMutator, asyncHandler(usersController.setZones));
