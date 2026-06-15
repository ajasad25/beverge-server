import { OrderStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { businessDateOnly } from '../lib/businessDay';

export type RetrySweepResult = {
  reactivated: string[]; // order ids returned to PENDING
  exhausted: string[]; // order ids past their max_retries cap
};

// Nightly sweep — runs after midnight per SRS §14.1 / D39.
// For every order currently in FAILED, increment retry_count:
//   * retry_count <= max_retries → status back to PENDING for next-day reassignment.
//     driver/assigned* are cleared so the admin reassigns deliberately.
//   * retry_count > max_retries  → stays FAILED, admin writes off / contacts retailer.
//
// audit_log.actor_id has a non-null FK to users, so cron-driven changes are
// recorded to stdout (captured by Railway logs) rather than the audit table,
// which remains strictly user-attributable.
export async function sweepFailedOrdersForRetry(): Promise<RetrySweepResult> {
  // The sweep runs just after midnight, so "today" is the new business day on
  // which the order becomes deliverable again. Re-stamp deliveryDate to it so
  // pending lists and deliveryDate-keyed analytics don't show a stale past date
  // (assignOrder re-bumps it if the admin reassigns on a later day).
  const today = businessDateOnly();

  const failed = await prisma.order.findMany({
    where: { status: OrderStatus.failed },
    select: { id: true, retryCount: true, maxRetries: true },
  });

  // INV-2: reactivate the whole batch atomically. Without the transaction a
  // crash mid-loop left some orders flipped to PENDING and the rest FAILED with
  // no rollback; now it's all-or-nothing. The returned ids are logged by the
  // scheduler's run() wrapper, so a completed sweep is diagnosable.
  return prisma.$transaction(async (tx) => {
    const reactivated: string[] = [];
    const exhausted: string[] = [];
    for (const order of failed) {
      const nextRetryCount = order.retryCount + 1;
      const cap = order.maxRetries ?? 2;
      if (nextRetryCount > cap) {
        exhausted.push(order.id);
        continue;
      }
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.pending,
          retryCount: nextRetryCount,
          deliveryDate: today,
          driverId: null,
          assignedAt: null,
          assignedBy: null,
        },
      });
      reactivated.push(order.id);
    }
    return { reactivated, exhausted };
  });
}
