import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { env } from './env';

const accessPayloadSchema = z.object({
  sub: z.string().uuid(),
  role: z.nativeEnum(Role),
  type: z.literal('access'),
});

const refreshPayloadSchema = z.object({
  sub: z.string().uuid(),
  type: z.literal('refresh'),
});

export type AccessTokenPayload = z.infer<typeof accessPayloadSchema>;
export type RefreshTokenPayload = z.infer<typeof refreshPayloadSchema>;

// Pin the algorithm so a token can't be forged by downgrading to "none" or to
// an asymmetric alg the verifier would treat as a public key, and bind tokens
// to this issuer/audience so a token minted for a different service can't be
// replayed here.
const ALGORITHM: jwt.Algorithm = 'HS256';
const ISSUER = 'beverage-api';
const AUDIENCE = 'beverage-clients';

export function signAccessToken(userId: string, role: Role): string {
  const opts: SignOptions = {
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
    algorithm: ALGORITHM,
    issuer: ISSUER,
    audience: AUDIENCE,
  };
  return jwt.sign({ sub: userId, role, type: 'access' }, env.JWT_SECRET, opts);
}

// jti lets a refresh token be tracked + revoked server-side (see auth.service).
export function signRefreshToken(userId: string, jti: string): string {
  const opts: SignOptions = {
    expiresIn: env.JWT_REFRESH_TTL_SECONDS,
    algorithm: ALGORITHM,
    issuer: ISSUER,
    audience: AUDIENCE,
    jwtid: jti,
  };
  return jwt.sign({ sub: userId, type: 'refresh' }, env.JWT_SECRET, opts);
}

const verifyOpts: jwt.VerifyOptions = {
  algorithms: [ALGORITHM],
  issuer: ISSUER,
  audience: AUDIENCE,
};

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET, verifyOpts);
  return accessPayloadSchema.parse(decoded);
}

export function verifyRefreshToken(token: string): RefreshTokenPayload & { jti?: string } {
  const decoded = jwt.verify(token, env.JWT_SECRET, verifyOpts);
  const parsed = refreshPayloadSchema.parse(decoded);
  const jti = typeof decoded === 'object' && decoded && 'jti' in decoded ? (decoded.jti as string) : undefined;
  return { ...parsed, jti };
}
