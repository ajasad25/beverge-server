import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as snapshotController from '../controllers/snapshot.controller';

export const snapshotRouter = Router();

snapshotRouter.use(requireAuth);

// GET /snapshot/salesman — full offline bundle for the authenticated salesman
// (SRS §5.1). Driver snapshot is a separate endpoint in S6.
snapshotRouter.get(
  '/salesman',
  requireRole(Role.salesman),
  asyncHandler(snapshotController.getSalesmanSnapshot)
);
