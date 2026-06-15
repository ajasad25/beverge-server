import { randomUUID } from 'node:crypto';
import type { Language, Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { hashPin, verifyPin } from '../lib/password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt';
import { classifyRevokedRefreshReuse } from '../lib/refreshTokenPolicy';
import { HttpError } from '../middleware/error.middleware';

// Revoked rows are kept this long so the AUTH-2 grace-re-mint can still resolve
// a dropped rotation; older revoked rows (and all expired rows) are prunable.
const REVOKED_PRUNE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// AUTH-1/AUTH-2: revoke every live refresh token for a user (credential change,
// or a detected token-theft breach). Accepts a tx client so it can run inside
// the same transaction as the triggering change.
export async function revokeAllUserRefreshTokens(
  userId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export type AuthenticatedUser = {
  id: string;
  name: string;
  phone: string;
  role: Role;
  language: Language;
};

export type LoginResult = {
  accessToken: string;
  refreshToken: string;
  user: AuthenticatedUser;
};

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

// Issue a tracked refresh token: persist a row keyed by a fresh jti, then sign
// a JWT carrying that jti. The row is what makes the token revocable.
async function issueRefreshToken(userId: string): Promise<string> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
  await prisma.refreshToken.create({ data: { id: jti, userId, expiresAt } });
  return signRefreshToken(userId, jti);
}

export async function loginWithPin(phone: string, pin: string): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { phone } });
  // Same error for missing user and bad PIN — don't leak account existence
  if (!user || !user.isActive || user.isDeleted) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid phone or PIN');
  }
  const ok = await verifyPin(pin, user.pinHash);
  if (!ok) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid phone or PIN');
  }
  return {
    accessToken: signAccessToken(user.id, user.role),
    refreshToken: await issueRefreshToken(user.id),
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      role: user.role,
      language: user.language,
    },
  };
}

const invalidRefresh = () =>
  new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');

export async function refreshTokens(refreshToken: string): Promise<TokenPair> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw invalidRefresh();
  }
  if (!payload.jti) throw invalidRefresh();

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.isActive || user.isDeleted) {
    throw invalidRefresh();
  }

  const stored = await prisma.refreshToken.findUnique({ where: { id: payload.jti } });
  if (!stored || stored.userId !== user.id || stored.expiresAt.getTime() < Date.now()) {
    throw invalidRefresh();
  }

  // Single-use rotation. A revoked token is normally a replay → reject. Two
  // exceptions are handled by classifyRevokedRefreshReuse (AUTH-2):
  //   • replacement still live  → almost certainly a dropped rotation response
  //     on a flaky field link: re-mint instead of locking the user out.
  //   • replacement ALSO rotated → an already-superseded token is being replayed
  //     (a theft signal): revoke the whole chain and refuse, observably.
  if (stored.revokedAt) {
    const replacement = stored.replacedById
      ? await prisma.refreshToken.findUnique({ where: { id: stored.replacedById } })
      : null;
    const action = classifyRevokedRefreshReuse(stored, replacement, Date.now());
    if (action === 'grace' && replacement) {
      return {
        accessToken: signAccessToken(user.id, user.role),
        refreshToken: signRefreshToken(user.id, replacement.id),
      };
    }
    if (action === 'breach') {
      await revokeAllUserRefreshTokens(user.id);
      // eslint-disable-next-line no-console
      console.warn(
        `[auth] refresh-token reuse after rotation (user ${user.id}, jti ${payload.jti}) — chain revoked`
      );
    }
    throw invalidRefresh();
  }

  // Active token: rotate it. Revoke the old row, link it to the new one.
  const newJti = randomUUID();
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
  await prisma.$transaction([
    prisma.refreshToken.create({ data: { id: newJti, userId: user.id, expiresAt } }),
    prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedById: newJti },
    }),
  ]);

  return {
    accessToken: signAccessToken(user.id, user.role),
    refreshToken: signRefreshToken(user.id, newJti),
  };
}

// Logout: revoke the presented refresh token (idempotent). The access token
// keeps working until it expires (≤24h) — acceptable; the session can no longer
// be renewed. Never throws on a bad/absent token so logout always "succeeds".
export async function revokeRefreshToken(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  try {
    const payload = verifyRefreshToken(refreshToken);
    if (payload.jti) {
      await prisma.refreshToken.updateMany({
        where: { id: payload.jti, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  } catch {
    /* malformed/expired token — nothing to revoke */
  }
}

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      phone: true,
      role: true,
      language: true,
      maxDiscountPct: true,
      maxDiscountPkr: true,
    },
  });
  if (!user) {
    throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
  }
  return user;
}

const PUBLIC_SELECT = {
  id: true,
  name: true,
  phone: true,
  role: true,
  language: true,
  maxDiscountPct: true,
  maxDiscountPkr: true,
} as const;

// Self-service profile edit — any authenticated user updates their OWN
// name/language. Distinct from admin user management (/users, US01/US02):
// no role gate beyond "authenticated", and you can only touch yourself.
export async function updateOwnProfile(
  userId: string,
  patch: { name?: string; language?: Language }
) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.language !== undefined ? { language: patch.language } : {}),
    },
    select: PUBLIC_SELECT,
  });
  return user;
}

// Self change-PIN: verify the current PIN before setting the new one
// (SRS SM05 spirit — the holder proves possession). Admin reset stays
// separate (/users/:id/reset-pin, no old-PIN needed).
export async function changeOwnPin(
  userId: string,
  oldPin: string,
  newPin: string
): Promise<{ ok: true }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pinHash: true },
  });
  if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
  if (!(await verifyPin(oldPin, user.pinHash))) {
    throw new HttpError(401, 'WRONG_PIN', 'Current PIN is incorrect');
  }
  // Hash outside the transaction so bcrypt doesn't hold the row lock open.
  const pinHash = await hashPin(newPin);
  // AUTH-1: a credential change must end every other session. Revoke all live
  // refresh tokens in the same transaction as the PIN update.
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { pinHash } });
    await revokeAllUserRefreshTokens(userId, tx);
  });
  return { ok: true };
}

// AUTH-4: nightly cleanup of refresh-token rows that can never be used again —
// expired tokens, plus rows revoked longer ago than the grace window. Keeps the
// table from growing unbounded (one row per login + per silent refresh).
export async function pruneRefreshTokens(now: Date = new Date()): Promise<number> {
  const revokedBefore = new Date(now.getTime() - REVOKED_PRUNE_GRACE_MS);
  const { count } = await prisma.refreshToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null, lt: revokedBefore } }],
    },
  });
  return count;
}
