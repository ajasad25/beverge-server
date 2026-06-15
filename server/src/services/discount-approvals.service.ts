import {
  DiscountApprovalStatus,
  OrderStatus,
  Prisma,
  type DiscountApproval,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';

export type ListApprovalsOpts = {
  status?: DiscountApprovalStatus;
  page?: number;
  pageSize?: number;
};

const idParamMessage = 'Approval id must be a UUID';

export async function listApprovals(opts: ListApprovalsOpts = {}): Promise<{
  approvals: Array<
    DiscountApproval & {
      order: {
        id: string;
        orderNumber: string;
        status: OrderStatus;
        totalValuePkr: Prisma.Decimal;
        retailerId: string;
        salesmanId: string;
        retailer: { shopName: string };
        salesman: { name: string };
      };
    }
  >;
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const where: Prisma.DiscountApprovalWhereInput = {
    ...(opts.status && { status: opts.status }),
  };
  const [approvals, total] = await Promise.all([
    prisma.discountApproval.findMany({
      where,
      orderBy: { requestedAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            totalValuePkr: true,
            retailerId: true,
            salesmanId: true,
            retailer: { select: { shopName: true } },
            salesman: { select: { name: true } },
          },
        },
      },
    }),
    prisma.discountApproval.count({ where }),
  ]);
  return { approvals, total, page, pageSize };
}

async function loadApprovalForReview(id: string): Promise<DiscountApproval> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new HttpError(400, 'INVALID_ID', idParamMessage);
  }
  const approval = await prisma.discountApproval.findUnique({ where: { id } });
  if (!approval) {
    throw new HttpError(404, 'APPROVAL_NOT_FOUND', 'Discount approval not found');
  }
  if (approval.status !== DiscountApprovalStatus.pending) {
    throw new HttpError(
      409,
      'APPROVAL_ALREADY_REVIEWED',
      `Approval was already ${approval.status} on ${approval.reviewedAt?.toISOString()}`
    );
  }
  return approval;
}

// SRS §3.3: PENDING_APPROVAL → PENDING when approved, → CANCELLED when rejected.
// Both transitions happen here, in one transaction with the approval-row update
// and the audit entry.
export async function approveDiscount(actor: AuditActor, id: string): Promise<DiscountApproval> {
  const approval = await loadApprovalForReview(id);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.discountApproval.update({
      where: { id },
      data: {
        status: DiscountApprovalStatus.approved,
        reviewedBy: actor.id,
        reviewedAt: new Date(),
      },
    });
    // Move the order out of PENDING_APPROVAL into PENDING so it can be
    // assigned to a driver (SRS §3.3).
    await tx.order.update({
      where: { id: approval.orderId },
      data: { status: OrderStatus.pending },
    });
    await recordAudit(
      {
        actor,
        action: 'approve',
        entityType: 'discount_approval',
        entityId: id,
        oldValue: approval,
        newValue: updated,
      },
      tx
    );
    return updated;
  });
}

export async function rejectDiscount(
  actor: AuditActor,
  id: string,
  reason: string
): Promise<DiscountApproval> {
  if (!reason.trim()) {
    throw new HttpError(400, 'REJECTION_REASON_REQUIRED', 'A rejection reason is required');
  }
  const approval = await loadApprovalForReview(id);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.discountApproval.update({
      where: { id },
      data: {
        status: DiscountApprovalStatus.rejected,
        rejectionReason: reason,
        reviewedBy: actor.id,
        reviewedAt: new Date(),
      },
    });
    // SRS §3.3: rejection terminates the order as CANCELLED. The salesman
    // is notified (SRS SM45) and may resubmit with revised pricing.
    await tx.order.update({
      where: { id: approval.orderId },
      data: { status: OrderStatus.cancelled },
    });
    await recordAudit(
      {
        actor,
        action: 'reject',
        entityType: 'discount_approval',
        entityId: id,
        oldValue: approval,
        newValue: updated,
      },
      tx
    );
    return updated;
  });
}
