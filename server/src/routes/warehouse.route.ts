import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as warehouseController from '../controllers/warehouse.controller';

export const warehouseRouter = Router();

// Warehouse data is admin-only — field roles do not see warehouse state
// per SRS §4.2 (column "Warehouse stock" is NO for salesman/driver).
warehouseRouter.use(requireAuth);
warehouseRouter.use(requireRole(Role.super_admin, Role.inventory_manager));

// Driver roster for the SOD loading dropdown (scoped to dispatch-desk roles).
warehouseRouter.get('/drivers', asyncHandler(warehouseController.listDrivers));

warehouseRouter.get('/stock', asyncHandler(warehouseController.listStock));
warehouseRouter.get('/stock/:productId', asyncHandler(warehouseController.getStock));
warehouseRouter.patch('/stock/:productId/threshold', asyncHandler(warehouseController.updateThreshold));
warehouseRouter.post('/stock/:productId/adjust', asyncHandler(warehouseController.adjustStock));

warehouseRouter.get('/movements', asyncHandler(warehouseController.listMovements));
warehouseRouter.get('/valuation', asyncHandler(warehouseController.valuation));

// GRN + EOD returns reconciliation (SRS WH03/WH05, §5.2 warehouse-wins)
warehouseRouter.post('/grn', asyncHandler(warehouseController.recordGrn));
warehouseRouter.get('/returns/pending', asyncHandler(warehouseController.listPendingReturns));
warehouseRouter.get('/returns/verified', asyncHandler(warehouseController.listVerifiedReturns));
warehouseRouter.post('/returns/verify', asyncHandler(warehouseController.verifyReturns));

// SOD vehicle loading (admin loads a chosen driver's vehicle at shift start)
warehouseRouter.get('/loading', asyncHandler(warehouseController.listLoading));
warehouseRouter.post('/loading', asyncHandler(warehouseController.loadVehicle));
