import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as pos from '../controllers/pos.controller';

export const posRouter = Router();

posRouter.use(requireAuth);

// Process sale: POS Cashier + Super Admin (SRS §4.2 "POS — process sale").
const cashier = requireRole(Role.pos_cashier, Role.super_admin);
posRouter.post('/sales', cashier, asyncHandler(pos.createSale));

// View history / receipts: + Finance Manager (SRS §4.2 "POS — view sales").
const viewer = requireRole(Role.pos_cashier, Role.super_admin, Role.finance_manager);
posRouter.get('/sales', viewer, asyncHandler(pos.listSales));
posRouter.get('/sales/:id', viewer, asyncHandler(pos.getSale));
posRouter.get('/summary', viewer, asyncHandler(pos.dailySummary));

// Post-confirmation void: Super Admin only (POS13) — enforced again in the
// service so the rule holds even if this guard is ever loosened.
posRouter.post('/sales/:id/void', requireRole(Role.super_admin), asyncHandler(pos.voidSale));
