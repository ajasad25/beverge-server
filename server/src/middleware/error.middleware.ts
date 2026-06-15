import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { env } from '../lib/env';

// Map a unique-constraint index name to a friendly client code. Service-level
// findFirst guards return these codes for the common case; this is the backstop
// when a concurrent request races past the guard and the DB rejects the insert.
const UNIQUE_VIOLATION_CODES: Record<string, { code: string; message: string }> = {
  payments_order_id_key: {
    code: 'PAYMENT_EXISTS',
    message: 'A payment is already recorded for this order',
  },
  orders_one_per_retailer_salesman_day: {
    code: 'DUPLICATE_DAILY_ORDER',
    message: 'An order for this retailer already exists today. Edit that order instead.',
  },
};

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.flatten(),
      },
    });
    return;
  }
  // Unique-constraint violation (e.g. the duplicate-payment / one-order-per-day
  // races) → 409 with a friendly code rather than a 500.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = Array.isArray(err.meta?.target)
      ? (err.meta.target as string[]).join(',')
      : String(err.meta?.target ?? '');
    const mapped = UNIQUE_VIOLATION_CODES[target] ?? {
      code: 'UNIQUE_CONSTRAINT',
      message: 'A record with these details already exists',
    };
    res.status(409).json({ error: mapped });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message:
        env.NODE_ENV === 'production'
          ? 'Internal server error'
          : err instanceof Error
            ? err.message
            : String(err),
    },
  });
}
