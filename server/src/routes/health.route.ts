import { Router } from 'express';
import * as healthController from '../controllers/health.controller';
import { asyncHandler } from '../utils/asyncHandler';

export const healthRouter = Router();

healthRouter.get('/', healthController.liveness);
healthRouter.get('/db', asyncHandler(healthController.readiness));
