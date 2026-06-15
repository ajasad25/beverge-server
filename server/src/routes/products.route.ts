import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import * as productsController from '../controllers/products.controller';

export const productsRouter = Router();

// Reads: any authenticated user — mobile apps need the catalog (SRS §4.2).
productsRouter.use(requireAuth);
productsRouter.get('/', asyncHandler(productsController.list));
productsRouter.get('/:id', asyncHandler(productsController.get));

// Mutations: Super Admin + Inventory Manager (SRS §4.2 row "Product catalog").
const inventoryOnly = requireRole(Role.super_admin, Role.inventory_manager);
productsRouter.post('/', inventoryOnly, asyncHandler(productsController.create));
productsRouter.patch('/:id', inventoryOnly, asyncHandler(productsController.update));
productsRouter.delete('/:id', inventoryOnly, asyncHandler(productsController.archive));
