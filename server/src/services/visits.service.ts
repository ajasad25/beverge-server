import { Role, VisitType, type Visit } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';

export type Actor = AuditActor & { role: Role };

export type CreateVisitInput = {
  retailerId: string;
  visitType: VisitType;
  orderId?: string | null;
  note?: string | null;
  // The client logs the wall-clock time of the visit offline; we trust it
  // (salesman actions are authoritative per SRS §5.2) but default to now.
  visitedAt?: string;
};

// SM15: "Visited — No Order" and order-linked visits. Salesman is always the
// actor; salesman_id is forced to the authenticated user (SRS §15.2 — the
// client cannot attribute a visit to someone else).
export async function createVisit(actor: Actor, input: CreateVisitInput): Promise<Visit> {
  if (actor.role !== Role.salesman) {
    throw new HttpError(403, 'SALESMAN_ONLY', 'Only salesmen log visits');
  }
  const retailer = await prisma.retailer.findFirst({
    where: { id: input.retailerId, isDeleted: false, primarySalesmanId: actor.id },
    select: { id: true },
  });
  if (!retailer) {
    throw new HttpError(404, 'RETAILER_NOT_FOUND', 'Retailer not found or not assigned to you');
  }
  if (input.orderId) {
    const order = await prisma.order.findFirst({
      where: { id: input.orderId, salesmanId: actor.id },
      select: { id: true },
    });
    if (!order) {
      throw new HttpError(400, 'INVALID_ORDER', 'orderId does not reference your order');
    }
  }

  return prisma.$transaction(async (tx) => {
    const visit = await tx.visit.create({
      data: {
        salesmanId: actor.id,
        retailerId: input.retailerId,
        orderId: input.orderId ?? null,
        visitType: input.visitType,
        note: input.note ?? null,
        visitedAt: input.visitedAt ? new Date(input.visitedAt) : new Date(),
      },
    });
    await recordAudit(
      { actor, action: 'create', entityType: 'visit', entityId: visit.id, newValue: visit },
      tx
    );
    return visit;
  });
}
