import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Auth throttling (login + change-pin). The SRS §15.2 rule is 5 attempts /
  // 15 min, which is the production default. It's relaxed in dev/test so local
  // E2E runs and an admin's honest fat-fingered PIN don't trigger a 15-minute
  // lockout. Set LOGIN_RATE_MAX to pin an explicit cap in any environment.
  LOGIN_RATE_MAX: z.coerce.number().int().positive().max(1000).optional(),
  LOGIN_RATE_WINDOW_MIN: z.coerce.number().int().positive().max(1440).default(15),
  // Comma-separated allowlist of browser origins for CORS. Leave unset in dev
  // (same-origin via the Vite proxy); set to the admin-web origin(s) in prod.
  CORS_ORIGIN: z.string().optional(),
  // Canonical timezone for the business day (order/delivery/shift dates, daily
  // reconciliation, POS day, alerts). The operator is single-city Pakistan, so
  // this defaults to Asia/Karachi. lib/businessDay reads BUSINESS_TIMEZONE
  // directly; this entry validates + documents it. CRON_TIMEZONE controls when
  // the nightly/hourly jobs fire and should normally match.
  BUSINESS_TIMEZONE: z.string().default('Asia/Karachi'),
  CRON_TIMEZONE: z.string().default('Asia/Karachi'),
  // Cloudflare R2 (S3-compatible) for delivery-proof photos. All four must be
  // set to enable uploads; if any is unset, photo upload is a no-op seam.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// SRS §15.2 (5 attempts / 15 min) must not be silently disabled in production
// via env. The relaxed default only ever applies in dev/test; refuse to start
// if a production deploy raises the login cap above a safe brute-force ceiling.
if (env.NODE_ENV === 'production' && (env.LOGIN_RATE_MAX ?? 5) > 10) {
  console.error('Refusing to start: LOGIN_RATE_MAX must be <= 10 in production (SRS §15.2).');
  process.exit(1);
}

export type Env = z.infer<typeof envSchema>;
