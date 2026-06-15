import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

export type AuditActor = {
  id: string;
  ipAddress?: string | null;
};

export type AuditEntry = {
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
};

type TxClient = Prisma.TransactionClient | typeof prisma;

export function actorFromRequest(req: Request): AuditActor {
  if (!req.auth) {
    throw new Error('actorFromRequest called without an authenticated request');
  }
  return {
    id: req.auth.sub,
    ipAddress: req.ip ?? req.socket.remoteAddress ?? null,
  };
}

// JSON.parse(JSON.stringify(...)) coerces Decimal and Date instances into
// their JSON representations so Postgres' jsonb column accepts them
function toJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function recordAudit(entry: AuditEntry, tx: TxClient = prisma): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: entry.actor.id,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      oldValue: toJsonValue(entry.oldValue) as Prisma.InputJsonValue,
      newValue: toJsonValue(entry.newValue) as Prisma.InputJsonValue,
      ipAddress: entry.actor.ipAddress ?? null,
    },
  });
}
