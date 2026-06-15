import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../lib/env';
import { pinPolicyError } from '../lib/pinPolicy';
import * as authService from '../services/auth.service';

// The web SPA holds the refresh token in an httpOnly cookie (out of reach of
// XSS); native mobile uses SecureStore and passes it in the request body. Both
// flows are supported: the cookie is set/cleared here, and the token is read
// from whichever source is present.
const REFRESH_COOKIE = 'refresh_token';
const refreshCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  // Browser-facing path: the SPA calls /api/auth/* (nginx strips /api before
  // Express). Scoping the cookie to the auth path keeps it off every other call.
  path: '/api/auth',
  maxAge: env.JWT_REFRESH_TTL_SECONDS * 1000,
});

function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === REFRESH_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

const loginSchema = z.object({
  phone: z.string().min(7).max(20),
  pin: z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits'),
});

export async function login(req: Request, res: Response): Promise<void> {
  const { phone, pin } = loginSchema.parse(req.body);
  const result = await authService.loginWithPin(phone, pin);
  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions());
  res.json(result);
}

// refreshToken may arrive in the cookie (web) or the body (mobile).
const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export async function refresh(req: Request, res: Response): Promise<void> {
  const body = refreshSchema.parse(req.body ?? {});
  const token = readRefreshCookie(req) ?? body.refreshToken;
  if (!token) {
    res.status(401).json({
      error: { code: 'INVALID_REFRESH_TOKEN', message: 'No refresh token provided' },
    });
    return;
  }
  const result = await authService.refreshTokens(token);
  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions());
  res.json(result);
}

export async function logout(req: Request, res: Response): Promise<void> {
  const token = readRefreshCookie(req) ?? (req.body?.refreshToken as string | undefined);
  await authService.revokeRefreshToken(token);
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
  res.json({ ok: true });
}

export async function me(req: Request, res: Response): Promise<void> {
  // requireAuth middleware guarantees req.auth is populated
  const user = await authService.getCurrentUser(req.auth!.sub);
  res.json({ user });
}

const updateMeSchema = z
  .object({
    name: z.string().min(1).max(120).trim().optional(),
    language: z.enum(['en', 'ur']).optional(),
  })
  .refine((d) => d.name !== undefined || d.language !== undefined, {
    message: 'Nothing to update',
  });

export async function updateMe(req: Request, res: Response): Promise<void> {
  const patch = updateMeSchema.parse(req.body);
  const user = await authService.updateOwnProfile(req.auth!.sub, patch);
  res.json({ user });
}

const changePinSchema = z
  .object({
    oldPin: z.string().regex(/^\d{6}$/, 'PIN must be 6 digits'),
    newPin: z.string().regex(/^\d{6}$/, 'PIN must be 6 digits'),
  })
  // AUTH-3: forbid no-op reuse and trivially weak PINs.
  .superRefine((v, ctx) => {
    const msg = pinPolicyError(v.newPin, v.oldPin);
    if (msg) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ['newPin'] });
  });

export async function changePin(req: Request, res: Response): Promise<void> {
  const { oldPin, newPin } = changePinSchema.parse(req.body);
  await authService.changeOwnPin(req.auth!.sub, oldPin, newPin);
  res.json({ ok: true });
}
