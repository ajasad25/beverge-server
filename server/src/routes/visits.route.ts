import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as visitsController from '../controllers/visits.controller';

export const visitsRouter = Router();

visitsRouter.use(requireAuth);

// SM15: salesmen log visits (incl. "Visited — No Order"). Service forces
// salesman_id = self and verifies the retailer is on this salesman's beat.
visitsRouter.post('/', requireRole(Role.salesman), asyncHandler(visitsController.create));
