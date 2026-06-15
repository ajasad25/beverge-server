import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { Role } from '@prisma/client';
import { HttpError } from './error.middleware';

export function requireRole(...allowed: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      throw new HttpError(401, 'NOT_AUTHENTICATED', 'Authentication required');
    }
    if (!allowed.includes(req.auth.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Role not permitted for this resource');
    }
    next();
  };
}

// Convenience groupings derived from SRS §4.2 Access Control Matrix.
export const ADMIN_ROLES: readonly Role[] = [
  Role.super_admin,
  Role.sales_manager,
  Role.inventory_manager,
  Role.finance_manager,
];

export const FIELD_ROLES: readonly Role[] = [Role.salesman, Role.driver];

export const ORDER_MANAGEMENT_ROLES: readonly Role[] = [Role.super_admin, Role.sales_manager];

export const POS_ROLES: readonly Role[] = [Role.super_admin, Role.pos_cashier];
