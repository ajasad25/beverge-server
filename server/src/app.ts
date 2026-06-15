import express, { type Express } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './lib/env';
import { authRouter } from './routes/auth.route';
import { healthRouter } from './routes/health.route';
import { zonesRouter } from './routes/zones.route';
import { productsRouter } from './routes/products.route';
import { warehouseRouter } from './routes/warehouse.route';
import { usersRouter } from './routes/users.route';
import { retailersRouter } from './routes/retailers.route';
import { settingsRouter } from './routes/settings.route';
import { pricingRouter } from './routes/pricing.route';
import { discountApprovalsRouter } from './routes/discount-approvals.route';
import { ordersRouter } from './routes/orders.route';
import { snapshotRouter } from './routes/snapshot.route';
import { visitsRouter } from './routes/visits.route';
import { driverRouter } from './routes/driver.route';
import { posRouter } from './routes/pos.route';
import { financeRouter } from './routes/finance.route';
import { alertsRouter } from './routes/alerts.route';
import { analyticsRouter } from './routes/analytics.route';
import { reportsRouter } from './routes/reports.route';
import { suppliersRouter } from './routes/suppliers.route';
import { purchasesRouter } from './routes/purchases.route';
import { expensesRouter } from './routes/expenses.route';
import { errorHandler, HttpError } from './middleware/error.middleware';

export function buildApp(): Express {
  const app = express();

  // Behind Railway's reverse proxy: trust exactly one hop so req.ip and
  // express-rate-limit see the real client IP, not the proxy. Without this the
  // login limiter keys on the single proxy IP and one bucket throttles/locks
  // out every user. `1` (not `true`) avoids trivial X-Forwarded-For spoofing.
  app.set('trust proxy', 1);

  app.use(helmet());
  // CORS: lock to an allowlist in production via CORS_ORIGIN (comma-separated
  // origins). Dev (Vite proxy) and prod (nginx) are same-origin, and native
  // mobile sends no Origin header, so this only constrains third-party browser
  // origins. In production an UNSET CORS_ORIGIN disables cross-origin browser
  // access (origin:false) rather than reflecting every origin — same-origin and
  // native clients are unaffected. Dev stays permissive for convenience.
  // credentials:true is required for the httpOnly refresh-token cookie.
  const corsOptions = env.CORS_ORIGIN
    ? { origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true }
    : env.NODE_ENV === 'production'
      ? { origin: false as const, credentials: true }
      : { credentials: true };
  app.use(cors(corsOptions));
  // gzip JSON responses. The salesman snapshot and the 200-row admin lists
  // are large, highly compressible payloads — biggest perceived-speed win on
  // mobile cellular and slow web links.
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  // SRS §15.2: 5 failed attempts → 15-minute lockout. Configurable via env so
  // the strict prod cap stays the default while dev/test relax it (local E2E
  // and honest PIN typos shouldn't lock an IP for 15 minutes). See lib/env.
  const authWindowMs = env.LOGIN_RATE_WINDOW_MIN * 60 * 1000;
  // Strict SRS §15.2 cap (5) is the default for every environment (the fail-safe
  // failure mode); only an explicit dev/test NODE_ENV relaxes it, and env.ts
  // refuses to start if a production deploy raises LOGIN_RATE_MAX past 10.
  const relaxedAuthEnv = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  const authMax = env.LOGIN_RATE_MAX ?? (relaxedAuthEnv ? 1000 : 5);
  const windowMinutes = Math.round(authWindowMs / 60000);
  const loginLimiter = rateLimit({
    windowMs: authWindowMs,
    max: authMax,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
      error: { code: 'RATE_LIMITED', message: `Too many login attempts. Try again in ${windowMinutes} minutes.` },
    },
  });
  // change-pin verifies the old 6-digit PIN, so a stolen access token could
  // otherwise brute-force it. Throttle hard (failures count, successes don't).
  const changePinLimiter = rateLimit({
    windowMs: authWindowMs,
    max: authMax,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
      error: { code: 'RATE_LIMITED', message: `Too many PIN-change attempts. Try again in ${windowMinutes} minutes.` },
    },
  });
  // refresh is legitimate-frequent but should not be an unbounded oracle.
  const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many refresh attempts. Try again shortly.' },
    },
  });

  app.use('/health', healthRouter);
  app.use('/auth/login', loginLimiter);
  app.use('/auth/refresh', refreshLimiter);
  app.use('/auth/change-pin', changePinLimiter);
  app.use('/auth', authRouter);
  app.use('/zones', zonesRouter);
  app.use('/products', productsRouter);
  app.use('/warehouse', warehouseRouter);
  app.use('/users', usersRouter);
  app.use('/retailers', retailersRouter);
  app.use('/settings', settingsRouter);
  app.use('/pricing', pricingRouter);
  app.use('/discount-approvals', discountApprovalsRouter);
  app.use('/orders', ordersRouter);
  app.use('/snapshot', snapshotRouter);
  app.use('/visits', visitsRouter);
  app.use('/driver', driverRouter);
  app.use('/pos', posRouter);
  app.use('/finance', financeRouter);
  app.use('/alerts', alertsRouter);
  app.use('/analytics', analyticsRouter);
  app.use('/reports', reportsRouter);
  app.use('/suppliers', suppliersRouter);
  app.use('/purchases', purchasesRouter);
  app.use('/expenses', expensesRouter);

  app.use((req, _res, next) => {
    next(new HttpError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
  });

  app.use(errorHandler);
  return app;
}
