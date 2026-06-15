import {
  DeliveryStatus,
  OrderStatus,
  PaymentMethod,
  Prisma,
  Role,
  StockMovementType,
  UnitType,
  type Order,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { addDays, businessDateOnly, businessDateOnlyFromKey } from '../lib/businessDay';
import { presignUpload } from '../lib/r2';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';

export type Actor = AuditActor & { role: Role };

function assertDriver(actor: Actor): void {
  if (actor.role !== Role.driver) {
    throw new HttpError(403, 'DRIVER_ONLY', 'This action is for drivers');
  }
}

// Resolve the business day a loading/EOD action belongs to. The client sends
// the local shift date so an action queued offline and drained after midnight
// still targets the right shift (otherwise yesterday's EOD reconciles against
// today's empty stock and poison-flags). Only today or yesterday is honored —
// anything else is ignored so a client can't back/forward-date shift data.
export function resolveShiftDate(key?: string, today: Date = businessDateOnly()): Date {
  if (!key) return today;
  const requested = businessDateOnlyFromKey(key);
  const yesterday = addDays(today, -1);
  return requested.getTime() === yesterday.getTime() ? yesterday : today;
}

// SRS §5.2: full SQLite snapshot of the driver's assigned orders at shift
// start. Scoped server-side to the authenticated driver; the client cannot
// widen scope (§15.2). One bundled payload (§15.1 < 15s on 3G).
export async function buildDriverSnapshot(driverId: string) {
  const today = businessDateOnly();

  const [orders, vehicleStock, settings] = await Promise.all([
    prisma.order.findMany({
      // Orders assigned to this driver and due today (delivery_date = order
      // date + 1, set at assignment). Includes already-actioned ones so the
      // app can group by status (DR10).
      where: { driverId, deliveryDate: today, status: { in: ['assigned', 'delivered', 'partial', 'failed'] } },
      include: {
        items: true,
        retailer: {
          select: {
            id: true,
            shopName: true,
            ownerName: true,
            phone: true,
            gpsLat: true,
            gpsLng: true,
            outstandingBalance: true,
            zoneId: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.vehicleStock.findMany({ where: { driverId, shiftDate: today } }),
    prisma.companySettings.findFirst({
      select: { name: true, currency: true, city: true },
    }),
  ]);

  return {
    serverTime: new Date().toISOString(),
    shiftDate: today.toISOString().slice(0, 10),
    // loadingConfirmed drives the DR06 gate: no delivery list until the
    // shift-start stock loading has been submitted.
    loadingConfirmed: vehicleStock.length > 0,
    orders,
    vehicleStock,
    settings,
  };
}

export type LoadingLine = { productId: string; unitType: UnitType; qty: number };

// DR04/DR05: confirm stock loaded per SKU per unit type. Decrements
// warehouse_stock, creates the vehicle_stock record, logs a 'load' stock
// movement — all atomically so warehouse and vehicle never disagree.
export async function confirmLoading(
  actor: Actor,
  lines: LoadingLine[],
  shiftDateKey?: string
): Promise<{ count: number }> {
  assertDriver(actor);
  if (lines.length === 0) {
    throw new HttpError(400, 'NO_LINES', 'At least one SKU is required');
  }
  const shiftDate = resolveShiftDate(shiftDateKey);

  return prisma.$transaction(async (tx) => {
    const already = await tx.vehicleStock.count({ where: { driverId: actor.id, shiftDate } });
    if (already > 0) {
      // Loading is a once-per-shift action (DR06). Re-submitting is a no-op
      // error rather than double-deducting warehouse stock.
      throw new HttpError(409, 'ALREADY_LOADED', 'Loading already confirmed for this shift');
    }
    for (const line of lines) {
      if (line.qty <= 0) continue;
      const stock = await tx.warehouseStock.findUnique({ where: { productId: line.productId } });
      if (!stock) {
        throw new HttpError(404, 'PRODUCT_NOT_STOCKED', `No warehouse stock for ${line.productId}`);
      }
      if (stock.quantityOnHand < line.qty) {
        throw new HttpError(
          409,
          'INSUFFICIENT_STOCK',
          `Only ${stock.quantityOnHand} of ${line.productId} on hand`
        );
      }
      // Guarded decrement so concurrent loading (or an admin loading the same
      // driver) can't drive warehouse stock negative.
      const dec = await tx.warehouseStock.updateMany({
        where: { productId: line.productId, quantityOnHand: { gte: line.qty } },
        data: { quantityOnHand: { decrement: line.qty } },
      });
      if (dec.count !== 1) {
        throw new HttpError(
          409,
          'INSUFFICIENT_STOCK',
          `Stock changed during loading; not enough ${line.productId} on hand`
        );
      }
      const vs = await tx.vehicleStock.create({
        data: {
          driverId: actor.id,
          shiftDate,
          productId: line.productId,
          unitType: line.unitType,
          qtyLoaded: line.qty,
        },
      });
      await tx.stockMovement.create({
        data: {
          productId: line.productId,
          movementType: StockMovementType.load,
          qty: -line.qty,
          unitType: line.unitType,
          referenceId: vs.id,
          actorId: actor.id,
          note: 'Vehicle loading at shift start',
        },
      });
    }
    await recordAudit(
      { actor, action: 'confirm_loading', entityType: 'vehicle_stock', entityId: actor.id },
      tx
    );
    return { count: lines.filter((l) => l.qty > 0).length };
  });
}

export type DeliveredItem = { productId: string; qtyDelivered: number };

export type DeliverInput = {
  status: DeliveryStatus;
  reasonCode?: string | null;
  photoUrl?: string | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
  // PARTIAL: per-item delivered quantities (DR15)
  deliveredItems?: DeliveredItem[];
  confirmedAt?: string;
};

// DR13-18: driver marks delivery. Driver is authoritative for delivery
// status (§5.2). Writes delivery_proofs, transitions the order, and
// decrements vehicle_stock qtyDelivered (DR30). Idempotent-ish: a second
// confirmation on an already-actioned order is rejected (DR18 — only Super
// Admin can override a DELIVERED order, handled elsewhere).
export async function confirmDelivery(
  actor: Actor,
  orderId: string,
  input: DeliverInput
): Promise<Order> {
  assertDriver(actor);
  if (input.status === DeliveryStatus.failed && !input.reasonCode?.trim()) {
    throw new HttpError(400, 'REASON_REQUIRED', 'Reason code is mandatory for a failed delivery');
  }

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, driverId: actor.id },
      include: { items: true },
    });
    if (!order) {
      throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not assigned to you');
    }
    if (order.status !== 'assigned') {
      throw new HttpError(
        409,
        'ALREADY_ACTIONED',
        `Order is ${order.status}; a driver cannot re-confirm it`
      );
    }

    await tx.deliveryProof.create({
      data: {
        orderId,
        driverId: actor.id,
        status: input.status,
        reasonCode: input.reasonCode ?? null,
        photoUrl: input.photoUrl ?? null,
        photoUploaded: Boolean(input.photoUrl),
        gpsLat: input.gpsLat != null ? new Prisma.Decimal(input.gpsLat) : null,
        gpsLng: input.gpsLng != null ? new Prisma.Decimal(input.gpsLng) : null,
        confirmedAt: input.confirmedAt ? new Date(input.confirmedAt) : new Date(),
      },
    });

    // 'not home' is a non-final attempt (DR16): log the proof above but leave
    // the order ASSIGNED so the driver can re-attempt later the same shift. Any
    // order still ASSIGNED at end-of-day is finalized to FAILED in submitEod.
    if (input.status === DeliveryStatus.not_home) {
      await recordAudit(
        {
          actor,
          action: 'deliver_attempt_not_home',
          entityType: 'order',
          entityId: orderId,
          oldValue: { status: order.status },
          newValue: { status: order.status, attempt: 'not_home' },
        },
        tx
      );
      return order;
    }

    const nextStatus =
      input.status === DeliveryStatus.delivered
        ? 'delivered'
        : input.status === DeliveryStatus.partial
          ? 'partial'
          : 'failed';

    // Map delivered quantities onto order_items + decrement vehicle stock. The
    // shift the stock belongs to is the order's delivery day, NOT the wall-clock
    // day this request happens to be processed — so a delivery_confirm that
    // syncs after midnight still updates the correct shift's vehicle_stock.
    const shiftDate = order.deliveryDate;
    const deliveredMap = new Map(
      (input.deliveredItems ?? []).map((d) => [d.productId, d.qtyDelivered])
    );
    for (const item of order.items) {
      const qd =
        input.status === DeliveryStatus.delivered
          ? item.qtyOrdered
          : input.status === DeliveryStatus.partial
            ? Math.min(item.qtyOrdered, deliveredMap.get(item.productId) ?? 0)
            : 0;
      await tx.orderItem.update({ where: { id: item.id }, data: { qtyDelivered: qd } });
      if (qd > 0) {
        await tx.vehicleStock.updateMany({
          where: {
            driverId: actor.id,
            shiftDate,
            productId: item.productId,
            unitType: item.unitType,
          },
          data: { qtyDelivered: { increment: qd } },
        });
      }
    }

    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: nextStatus },
    });
    await recordAudit(
      {
        actor,
        action: `deliver_${nextStatus}`,
        entityType: 'order',
        entityId: orderId,
        oldValue: { status: order.status },
        newValue: { status: nextStatus },
      },
      tx
    );
    return updated;
  });
}

export type PaymentInput = {
  amountPkr: number | string;
  method: PaymentMethod;
  referenceNo?: string | null;
  dueDate?: string | null;
};

// DR19: payment recorded after delivery. One payment per order. Adds to the
// retailer's outstanding balance when method = credit.
export async function recordPayment(
  actor: Actor,
  orderId: string,
  input: PaymentInput
): Promise<{ id: string }> {
  assertDriver(actor);
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, driverId: actor.id },
      select: { id: true, retailerId: true, status: true },
    });
    if (!order) {
      throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not assigned to you');
    }
    // A payment only makes sense against a completed delivery — never an
    // ASSIGNED (undelivered) or FAILED order.
    if (order.status !== OrderStatus.delivered && order.status !== OrderStatus.partial) {
      throw new HttpError(
        409,
        'ORDER_NOT_DELIVERED',
        `Cannot record a payment for a ${order.status} order`
      );
    }
    const existing = await tx.payment.findFirst({ where: { orderId } });
    if (existing) {
      throw new HttpError(409, 'PAYMENT_EXISTS', 'A payment is already recorded for this order');
    }
    const amount = new Prisma.Decimal(input.amountPkr);
    if (amount.lte(0)) {
      throw new HttpError(400, 'INVALID_AMOUNT', 'Payment amount must be greater than zero');
    }
    const payment = await tx.payment.create({
      data: {
        orderId,
        retailerId: order.retailerId,
        driverId: actor.id,
        amountPkr: amount,
        method: input.method,
        referenceNo: input.referenceNo ?? null,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
      },
    });
    if (input.method === PaymentMethod.credit) {
      await tx.retailer.update({
        where: { id: order.retailerId },
        data: { outstandingBalance: { increment: amount } },
      });
    }
    await recordAudit(
      { actor, action: 'record_payment', entityType: 'payment', entityId: payment.id, newValue: payment },
      tx
    );
    return { id: payment.id };
  });
}

export type EodReturnLine = { productId: string; unitType: UnitType; qtyReturned: number };

// DR32-35: end of day. Driver logs undelivered stock per SKU and the cash
// handover total. System flags a discrepancy when logged returns != loaded -
// delivered (DR33). Warehouse manager later sets qtyReturnedVerified (S8) —
// physical count wins per §5.2.
export async function submitEod(
  actor: Actor,
  returns: EodReturnLine[],
  cashHandoverPkr: number | string,
  shiftDateKey?: string
): Promise<{ discrepancies: number; failedUndelivered: number }> {
  assertDriver(actor);
  const shiftDate = resolveShiftDate(shiftDateKey);

  return prisma.$transaction(async (tx) => {
    const rows = await tx.vehicleStock.findMany({ where: { driverId: actor.id, shiftDate } });
    if (rows.length === 0) {
      throw new HttpError(409, 'NO_SHIFT', 'No loading found for that shift — nothing to reconcile');
    }
    const returnMap = new Map(
      returns.map((r) => [`${r.productId}:${r.unitType}`, r.qtyReturned])
    );
    let discrepancies = 0;
    for (const row of rows) {
      const logged = returnMap.get(`${row.productId}:${row.unitType}`) ?? 0;
      const expected = row.qtyLoaded - row.qtyDelivered;
      const flag = logged !== expected;
      if (flag) discrepancies += 1;
      await tx.vehicleStock.update({
        where: { id: row.id },
        data: { qtyReturnedLogged: logged, discrepancyFlag: flag },
      });
    }

    // Any order still ASSIGNED to this driver for the shift is undelivered at
    // end of day (incl. 'not home' stops never re-attempted) → finalize to
    // FAILED so the nightly sweep retries it (DR16/D39).
    const undelivered = await tx.order.findMany({
      where: { driverId: actor.id, deliveryDate: shiftDate, status: 'assigned' },
      select: { id: true },
    });
    if (undelivered.length > 0) {
      await tx.order.updateMany({
        where: { id: { in: undelivered.map((o) => o.id) } },
        data: { status: 'failed' },
      });
    }

    await recordAudit(
      {
        actor,
        action: 'submit_eod',
        entityType: 'vehicle_stock',
        entityId: actor.id,
        newValue: {
          cashHandoverPkr: String(cashHandoverPkr),
          discrepancies,
          failedUndelivered: undelivered.map((o) => o.id),
        },
      },
      tx
    );
    return { discrepancies, failedUndelivered: undelivered.length };
  });
}

// ─── Delivery-proof photo upload (SRS §5.3 / DR21, R2) ────────────────────
const PROOF_CONTENT_TYPES = new Set(['image/jpeg', 'image/png']);

// Issue a short-lived pre-signed PUT URL the driver app uploads the proof photo
// to directly (keeps the bytes off the API). The key is namespaced per order so
// attachProofPhoto can validate ownership.
export async function presignProofUpload(
  actor: Actor,
  orderId: string,
  contentType: string
): Promise<{ uploadUrl: string; key: string }> {
  assertDriver(actor);
  if (!PROOF_CONTENT_TYPES.has(contentType)) {
    throw new HttpError(400, 'INVALID_CONTENT_TYPE', 'Proof photos must be JPEG or PNG');
  }
  const order = await prisma.order.findFirst({
    where: { id: orderId, driverId: actor.id },
    select: { id: true },
  });
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not assigned to you');
  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  const key = `delivery-proofs/${orderId}/${randomUUID()}.${ext}`;
  const uploadUrl = await presignUpload(key, contentType);
  return { uploadUrl, key };
}

// Backfill the uploaded object key onto the order's delivery proof once the
// client confirms the PUT succeeded (the proof row was created by confirmDelivery
// with photoUrl null).
export async function attachProofPhoto(
  actor: Actor,
  orderId: string,
  key: string
): Promise<{ ok: true }> {
  assertDriver(actor);
  if (!key.startsWith(`delivery-proofs/${orderId}/`)) {
    throw new HttpError(400, 'INVALID_KEY', 'Key does not belong to this order');
  }
  const proof = await prisma.deliveryProof.findFirst({
    where: { orderId, driverId: actor.id },
    orderBy: { confirmedAt: 'desc' },
    select: { id: true },
  });
  if (!proof) throw new HttpError(404, 'PROOF_NOT_FOUND', 'No delivery proof to attach a photo to');
  await prisma.deliveryProof.update({
    where: { id: proof.id },
    data: { photoUrl: key, photoUploaded: true },
  });
  return { ok: true };
}
