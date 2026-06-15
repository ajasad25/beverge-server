import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

// SRS §5.3/§16 — dual-offline sync dedupe. Queued mutations retry until they
// flag or succeed; a request that already applied server-side (but whose
// response never reached the device) must NOT apply a second time. The
// client sends a stable Idempotency-Key (its sync_queue row id). The first
// apply persists the JSON response; replays return it verbatim.
//
// No key → run normally (e.g. admin web calls that aren't queue-driven).
export async function withIdempotency<T>(
  key: string | undefined,
  scope: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!key) return fn();

  const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
  if (existing) return existing.response as T;

  const result = await fn();

  try {
    await prisma.idempotencyKey.create({
      data: { key, scope, response: result as Prisma.InputJsonValue },
    });
  } catch (err) {
    // Lost a race with a concurrent same-key request: the side effect ran
    // once (fn is the mutation), and the winner stored the canonical
    // response. Return that to stay consistent.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.idempotencyKey.findUnique({ where: { key } });
      if (winner) return winner.response as T;
    }
    throw err;
  }
  return result;
}
