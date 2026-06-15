import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as driver from '../controllers/driver.controller';

export const driverRouter = Router();

// Every driver endpoint is driver-role only; the service additionally scopes
// all reads/writes to the authenticated driver (SRS §15.2).
driverRouter.use(requireAuth, requireRole(Role.driver));

driverRouter.get('/snapshot', asyncHandler(driver.snapshot));
driverRouter.post('/loading', asyncHandler(driver.loading));
driverRouter.post('/orders/:id/deliver', asyncHandler(driver.deliver));
driverRouter.post('/orders/:id/payment', asyncHandler(driver.payment));
driverRouter.post('/orders/:id/proof-upload-url', asyncHandler(driver.proofUploadUrl));
driverRouter.post('/orders/:id/proof-photo', asyncHandler(driver.attachProof));
driverRouter.post('/eod', asyncHandler(driver.eod));
