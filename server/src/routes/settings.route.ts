import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as settingsController from '../controllers/settings.controller';

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

// Reads — open to every authenticated user. Mobile apps need company name,
// logo, and currency for receipts and headers; admin web needs everything.
settingsRouter.get('/', asyncHandler(settingsController.get));

// Mutations — Super Admin only (SRS §9.7, US01).
settingsRouter.patch('/', requireRole(Role.super_admin), asyncHandler(settingsController.update));
