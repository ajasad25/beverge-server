import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, type AccessTokenPayload } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { HttpError } from './error.middleware';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessTokenPayload;
    }
  }
}

// Access tokens live 24h (required so an offline field user survives a full
// day after the morning snapshot), so the token alone cannot express
// "deactivated 10 minutes ago". We re-check the user against the DB on every
// request and re-derive the role from the row, so deactivating, soft-deleting,
// or changing a user's role takes effect immediately instead of lingering for
// up to 24h. The user table is tiny (<10 field users + a handful of admins),
// so this indexed primary-key lookup is negligible.
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) {
    return next(new HttpError(401, 'MISSING_TOKEN', 'Authorization header missing or malformed'));
  }
  const token = header.slice('bearer '.length).trim();
  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(new HttpError(401, 'INVALID_TOKEN', 'Invalid or expired token'));
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, isActive: true, isDeleted: true },
    });
    if (!user || !user.isActive || user.isDeleted) {
      return next(new HttpError(401, 'USER_INACTIVE', 'User account is inactive'));
    }
    // Re-derive role from the live row so a role change is enforced at once.
    req.auth = { ...payload, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}
