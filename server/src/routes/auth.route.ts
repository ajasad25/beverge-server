import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth.middleware';

export const authRouter = Router();

authRouter.post('/login', asyncHandler(authController.login));
authRouter.post('/refresh', asyncHandler(authController.refresh));
authRouter.post('/logout', asyncHandler(authController.logout));
authRouter.get('/me', requireAuth, asyncHandler(authController.me));
authRouter.patch('/me', requireAuth, asyncHandler(authController.updateMe));
authRouter.post('/change-pin', requireAuth, asyncHandler(authController.changePin));
