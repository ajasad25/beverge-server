import {
  DiscountApprovalStatus,
  DiscountType,
  OrderStatus,
  Prisma,
  Role,
  type Order,
  type OrderItem,
  type Product,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { addDays, businessDateOnly } from '../lib/businessDay';
import { recordAudit, type AuditActor } from '../lib/audit';
import { HttpError } from '../middleware/error.middleware';
import {
  checkSalesmanDiscountLimit,
  computeLine,
  computeOrderTotals,
  priceWasRevised,
  type LineResult,
} from '../lib/pricing';

export type Actor = AuditActor & { role: Role };

export type OrderItemInput = {
  productId: string;
  qty: number;
  discountType?: DiscountType;
  discountValue?: number | string;
  // PRICE-1 / SRS §5.1: the unit price the offline app showed the salesman, sent
  // for comparison ONLY. Never used to charge — the server always recomputes the
  // effective price; this just flags a sync-time revision for the salesman notice.
  capturedUnitPrice?: number | string;
};

export type CreateOrderInput = {
  retailerId: string;
  items: OrderItemInput[];
  note?: string;
  // Admin-only: when the admin creates an order on behalf of a salesman (D34).
  // Ignored when the actor is a salesman (they're always the salesman_id).
  salesmanId?: string;
  // The device's local capture time, sent by the offline app so order_date
  // reflects when the order was actually placed (see capture-date rule below).
  capturedAt?: string;
};

export type OrderWithItems = Order & { items: OrderItem[] };

// #7 capture-date attribution. Honor the device's capture day so order_date
// reflects when the salesman actually placed the order (and aligns with the
// app's local one-order-per-day guard). But if it synced after the would-be
// delivery day already arrived (capture + 1 <= today), the next-day slot is
// gone — re-date to the sync day so it delivers the following day instead. A
// future capture date (device clock skew) is clamped to today.
export function attributeOrderDate(capturedAt?: string, today: Date = businessDateOnly()): Date {
  const rawCapture = capturedAt ? businessDateOnly(new Date(capturedAt)) : today;
  const captureDay = rawCapture.getTime() > today.getTime() ? today : rawCapture;
  return addDays(captureDay, 1).getTime() > today.getTime() ? captureDay : today;
}

async function resolveSalesmanId(actor: Actor, input: CreateOrderInput): Promise<string> {
  if (actor.role === Role.salesman) {
    // Salesman submissions always attribute to the actor — payload ignored.
    return actor.id;
  }
  // Admin path (SRS D34): salesmanId is required.
  if (!input.salesmanId) {
    throw new HttpError(
      400,
      'SALESMAN_REQUIRED',
      'salesmanId is required when an admin creates an order on behalf of a salesman'
    );
  }
  const u = await prisma.user.findUnique({
    where: { id: input.salesmanId },
    select: { role: true, isActive: true, isDeleted: true },
  });
  if (!u || u.isDeleted || !u.isActive || u.role !== Role.salesman) {
    throw new HttpError(400, 'INVALID_SALESMAN', 'salesmanId must reference an active salesman');
  }
  return input.salesmanId;
}

// SRS D10: one order per salesman per retailer per day. An existing order in
// any non-terminal state for today blocks a second creation — the salesman
// edits the existing order instead.
async function assertNoDuplicateOrder(retailerId: string, salesmanId: string, orderDate: Date): Promise<void> {
  const conflict = await prisma.order.findFirst({
    where: {
      retailerId,
      salesmanId,
      orderDate,
      status: { notIn: [OrderStatus.cancelled, OrderStatus.failed] },
    },
    select: { id: true, status: true },
  });
  if (conflict) {
    throw new HttpError(
      409,
      'DUPLICATE_DAILY_ORDER',
      `An order for this retailer already exists today (order ${conflict.id}, status ${conflict.status}). Edit that order instead.`
    );
  }
}

// Atomically reserve the next per-year sequence and format the human-readable
// order number (ORD-YYYY-NNNNNN). The upsert row-locks the year's counter, so
// concurrent salesman syncs get gapless, collision-free numbers. Must run
// inside the order-creation transaction.
async function nextOrderNumber(
  tx: Prisma.TransactionClient,
  year: number
): Promise<string> {
  const rows = await tx.$queryRaw<{ last_seq: number }[]>`
    INSERT INTO order_counters (year, last_seq) VALUES (${year}, 1)
    ON CONFLICT (year) DO UPDATE SET last_seq = order_counters.last_seq + 1
    RETURNING last_seq
  `;
  const seq = rows[0]?.last_seq;
  if (seq == null) {
    throw new HttpError(500, 'ORDER_NUMBER_FAILED', 'Could not allocate order number');
  }
  return `ORD-${year}-${String(seq).padStart(6, '0')}`;
}

export async function createOrder(actor: Actor, input: CreateOrderInput): Promise<OrderWithItems> {
  if (input.items.length === 0) {
    throw new HttpError(400, 'EMPTY_ORDER', 'At least one line item is required');
  }
  const salesmanId = await resolveSalesmanId(actor, input);

  // Retailer + zone — salesman scope enforced server-side (SRS §15.2)
  const retailer = await prisma.retailer.findFirst({
    where: {
      id: input.retailerId,
      isDeleted: false,
      status: { not: 'inactive' },
      ...(actor.role === Role.salesman && { primarySalesmanId: actor.id }),
    },
    select: { id: true, zoneId: true, status: true, primarySalesmanId: true },
  });
  if (!retailer) {
    throw new HttpError(404, 'RETAILER_NOT_FOUND', 'Retailer not found or not assigned to you');
  }
  if (retailer.status === 'suspended') {
    throw new HttpError(403, 'RETAILER_SUSPENDED', 'Cannot place an order for a suspended retailer');
  }

  const orderDate = attributeOrderDate(input.capturedAt);
  await assertNoDuplicateOrder(retailer.id, salesmanId, orderDate);

  // Load products + retailer prices
  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, isDeleted: false, isActive: true },
    select: { id: true, sku: true, name: true, unitType: true, basePrice: true },
  });
  if (products.length !== productIds.length) {
    throw new HttpError(400, 'UNKNOWN_PRODUCTS', 'One or more products not found, archived, or inactive');
  }
  const productById = new Map<string, Pick<Product, 'id' | 'sku' | 'name' | 'unitType' | 'basePrice'>>(
    products.map((p) => [p.id, p])
  );

  const specialPriceRows = await prisma.retailerPrice.findMany({
    where: { retailerId: retailer.id, productId: { in: productIds } },
    select: { productId: true, specialPrice: true },
  });
  const specialByProduct = new Map(specialPriceRows.map((s) => [s.productId, s.specialPrice]));

  // Compute every line
  const computed: Array<{ input: OrderItemInput; line: LineResult; product: typeof products[number] }> = [];
  for (const item of input.items) {
    const product = productById.get(item.productId);
    if (!product) {
      throw new HttpError(400, 'UNKNOWN_PRODUCT', `Product ${item.productId} not found`);
    }
    const line = computeLine({
      basePrice: product.basePrice,
      specialPrice: specialByProduct.get(item.productId) ?? null,
      discountType: item.discountType ?? DiscountType.none,
      discountValue: item.discountValue ?? 0,
      qty: item.qty,
    });
    computed.push({ input: item, line, product });
  }
  const totals = computeOrderTotals({ lines: computed.map((c) => c.line) });

  // Status decision (SRS §3.3, D13). Admins (D34) bypass the salesman-limit gate.
  let initialStatus: OrderStatus = OrderStatus.pending;
  let requiresApproval = false;
  if (actor.role === Role.salesman) {
    const salesman = await prisma.user.findUnique({
      where: { id: salesmanId },
      select: { maxDiscountPct: true, maxDiscountPkr: true },
    });
    const check = checkSalesmanDiscountLimit(
      salesman ?? { maxDiscountPct: null, maxDiscountPkr: null },
      computed.map((c) => c.line)
    );
    if (check.requiresApproval) {
      initialStatus = OrderStatus.pending_approval;
      requiresApproval = true;
    }
  }

  // Resolve per-order maxRetries — default from company_settings.deliveryRetryLimit
  const settings = await prisma.companySettings.findFirst({ select: { deliveryRetryLimit: true } });
  const maxRetries = settings?.deliveryRetryLimit ?? 2;

  const result = await prisma.$transaction(async (tx) => {
    const orderNumber = await nextOrderNumber(tx, orderDate.getFullYear());
    const order = await tx.order.create({
      data: {
        orderNumber,
        retailerId: retailer.id,
        salesmanId,
        zoneId: retailer.zoneId,
        status: initialStatus,
        orderDate,
        deliveryDate: addDays(orderDate, 1), // SRS D9
        note: input.note ?? null,
        totalValuePkr: totals.subtotal,
        maxRetries,
      },
    });
    await tx.orderItem.createMany({
      data: computed.map((c) => ({
        orderId: order.id,
        productId: c.product.id,
        unitType: c.product.unitType,
        qtyOrdered: c.input.qty,
        unitPrice: c.line.basePrice,
        specialPriceApplied: c.line.specialPrice,
        discountType: c.input.discountType ?? DiscountType.none,
        discountValue: c.input.discountValue != null ? new Prisma.Decimal(c.input.discountValue) : new Prisma.Decimal(0),
        effectiveUnitPrice: c.line.effectiveUnitPrice,
        // PRICE-1 / SRS §5.1: flag lines whose server price differs from what the
        // salesman captured offline, so the "total revised X→Y" notice can fire.
        priceRevisedOnSync: priceWasRevised(c.line.effectiveUnitPrice, c.input.capturedUnitPrice),
      })),
    });
    if (requiresApproval) {
      await tx.discountApproval.create({
        data: {
          orderId: order.id,
          requestedBy: salesmanId,
          status: DiscountApprovalStatus.pending,
        },
      });
    }
    await recordAudit(
      {
        actor,
        action: 'create',
        entityType: 'order',
        entityId: order.id,
        newValue: { ...order, requiresApproval },
      },
      tx
    );
    const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
    return { ...order, items };
  });

  return result;
}

// ─── Reads ───────────────────────────────────────────────────────────────

export type ListOrdersOpts = {
  status?: OrderStatus;
  search?: string;
  zoneId?: string;
  salesmanId?: string;
  driverId?: string;
  retailerId?: string;
  fromDate?: Date;
  toDate?: Date;
  page?: number;
  pageSize?: number;
};

function applyActorOrderScope(where: Prisma.OrderWhereInput, actor: Actor): Prisma.OrderWhereInput {
  switch (actor.role) {
    case Role.salesman:
      return { ...where, salesmanId: actor.id };
    case Role.driver:
      return { ...where, driverId: actor.id };
    default:
      return where;
  }
}

// Lightweight relation names so the admin list/detail can show real labels
// (Order #, retailer, salesman, driver) instead of raw UUIDs.
const ORDER_LIST_INCLUDE = {
  retailer: { select: { shopName: true } },
  salesman: { select: { name: true } },
  driver: { select: { name: true } },
  zone: { select: { name: true } },
} satisfies Prisma.OrderInclude;

export type OrderListRow = Prisma.OrderGetPayload<{ include: typeof ORDER_LIST_INCLUDE }>;

export async function listOrders(actor: Actor, opts: ListOrdersOpts = {}): Promise<{
  orders: OrderListRow[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const where = applyActorOrderScope(
    {
      ...(opts.status && { status: opts.status }),
      ...(opts.search && {
        OR: [
          { orderNumber: { contains: opts.search, mode: 'insensitive' } },
          { retailer: { shopName: { contains: opts.search, mode: 'insensitive' } } },
          { salesman: { name: { contains: opts.search, mode: 'insensitive' } } },
        ],
      }),
      ...(opts.zoneId && { zoneId: opts.zoneId }),
      ...(opts.salesmanId && { salesmanId: opts.salesmanId }),
      ...(opts.driverId && { driverId: opts.driverId }),
      ...(opts.retailerId && { retailerId: opts.retailerId }),
      ...((opts.fromDate || opts.toDate) && {
        orderDate: {
          ...(opts.fromDate && { gte: opts.fromDate }),
          ...(opts.toDate && { lte: opts.toDate }),
        },
      }),
    },
    actor
  );
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { orderDate: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: ORDER_LIST_INCLUDE,
    }),
    prisma.order.count({ where }),
  ]);
  return { orders, total, page, pageSize };
}

const ORDER_DETAIL_INCLUDE = {
  ...ORDER_LIST_INCLUDE,
  items: { include: { product: { select: { name: true, sku: true } } } },
} satisfies Prisma.OrderInclude;

export type OrderDetail = Prisma.OrderGetPayload<{ include: typeof ORDER_DETAIL_INCLUDE }>;

export async function getOrder(actor: Actor, id: string): Promise<OrderDetail> {
  const where = applyActorOrderScope({ id }, actor);
  const order = await prisma.order.findFirst({ where, include: ORDER_DETAIL_INCLUDE });
  if (!order) {
    throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }
  return order;
}

// ─── Edit (SRS OR09, D35) ────────────────────────────────────────────────

// Admins can edit while PENDING or PENDING_APPROVAL — not after ASSIGNED.
// Salesman can edit their own order until midnight (D10) while PENDING.
function assertEditable(order: Order, actor: Actor): void {
  const baseEditable =
    order.status === OrderStatus.pending || order.status === OrderStatus.pending_approval;
  // FEAT-2: admins (never the salesman) may also edit an ASSIGNED order until the
  // driver's vehicle is loaded for delivery — the "driver has left" cutoff,
  // verified asynchronously in updateOrder via assertNotDispatched.
  const adminAssignedEdit =
    order.status === OrderStatus.assigned && actor.role !== Role.salesman;
  if (!baseEditable && !adminAssignedEdit) {
    throw new HttpError(
      409,
      'ORDER_NOT_EDITABLE',
      `Order in status ${order.status} can no longer be edited`
    );
  }
  if (actor.role === Role.salesman) {
    if (order.salesmanId !== actor.id) {
      throw new HttpError(403, 'NOT_YOUR_ORDER', 'You can only edit your own orders');
    }
    if (order.status === OrderStatus.pending_approval) {
      throw new HttpError(
        409,
        'AWAITING_APPROVAL',
        'Order is awaiting approval; cancel and resubmit to revise pricing'
      );
    }
    const today = businessDateOnly();
    if (order.orderDate.getTime() < today.getTime()) {
      throw new HttpError(409, 'ORDER_LOCKED', 'Order is past midnight cut-off and is locked for edits (SRS D10)');
    }
  }
}

// FEAT-2 cutoff: an ASSIGNED order is editable only until its driver's vehicle
// has been loaded for the delivery day. A vehicle_stock row for that driver on
// the delivery date means stock is already committed against the run, so the
// edit window is closed.
async function assertNotDispatched(order: Order): Promise<void> {
  if (order.status !== OrderStatus.assigned || !order.driverId) return;
  const loaded = await prisma.vehicleStock.count({
    where: { driverId: order.driverId, shiftDate: order.deliveryDate },
  });
  if (loaded > 0) {
    throw new HttpError(
      409,
      'ORDER_DISPATCHED',
      "The driver's vehicle is already loaded for delivery; this order can no longer be edited"
    );
  }
}

export type UpdateOrderInput = {
  note?: string | null;
  items?: OrderItemInput[]; // Full replacement of the line set
};

export async function updateOrder(actor: Actor, id: string, patch: UpdateOrderInput): Promise<OrderWithItems> {
  const existing = await getOrder(actor, id);
  assertEditable(existing, actor);
  await assertNotDispatched(existing);

  // If items are not changing, just patch the note
  if (patch.items === undefined) {
    if (patch.note === undefined) {
      throw new HttpError(400, 'EMPTY_PATCH', 'Nothing to update');
    }
    const updated = await prisma.$transaction(async (tx) => {
      const o = await tx.order.update({
        where: { id },
        data: { note: patch.note ?? null },
      });
      await recordAudit(
        {
          actor,
          action: 'update',
          entityType: 'order',
          entityId: id,
          oldValue: { note: existing.note },
          newValue: { note: patch.note },
        },
        tx
      );
      return o;
    });
    return { ...updated, items: existing.items };
  }

  // Recompute pricing for the new line set
  if (patch.items.length === 0) {
    throw new HttpError(400, 'EMPTY_ORDER', 'An order must have at least one line item');
  }
  const productIds = [...new Set(patch.items.map((i) => i.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, isDeleted: false, isActive: true },
    select: { id: true, sku: true, name: true, unitType: true, basePrice: true },
  });
  if (products.length !== productIds.length) {
    throw new HttpError(400, 'UNKNOWN_PRODUCTS', 'One or more products not found, archived, or inactive');
  }
  const productById = new Map(products.map((p) => [p.id, p]));
  const specialPriceRows = await prisma.retailerPrice.findMany({
    where: { retailerId: existing.retailerId, productId: { in: productIds } },
    select: { productId: true, specialPrice: true },
  });
  const specialByProduct = new Map(specialPriceRows.map((s) => [s.productId, s.specialPrice]));

  const computed = patch.items.map((item) => {
    const product = productById.get(item.productId);
    if (!product) {
      throw new HttpError(400, 'UNKNOWN_PRODUCT', `Product ${item.productId} not found`);
    }
    const line = computeLine({
      basePrice: product.basePrice,
      specialPrice: specialByProduct.get(item.productId) ?? null,
      discountType: item.discountType ?? DiscountType.none,
      discountValue: item.discountValue ?? 0,
      qty: item.qty,
    });
    return { input: item, line, product };
  });
  const totals = computeOrderTotals({ lines: computed.map((c) => c.line) });

  // Re-evaluate approval for the new line set against the salesman's limits for
  // EVERY editor (not just the salesman). Otherwise an admin editing a
  // PENDING_APPROVAL order left newStatus = pending_approval while the
  // auto-clear branch below marked the approval row approved — stranding the
  // order (un-approvable AND un-assignable). Deriving status from the limit
  // check keeps order status and the approval row consistent (bug1).
  const salesman = await prisma.user.findUnique({
    where: { id: existing.salesmanId },
    select: { maxDiscountPct: true, maxDiscountPkr: true },
  });
  const check = checkSalesmanDiscountLimit(
    salesman ?? { maxDiscountPct: null, maxDiscountPkr: null },
    computed.map((c) => c.line)
  );
  const requiresApproval = check.requiresApproval;
  // FEAT-2: editing an ASSIGNED order (pre-dispatch) keeps it ASSIGNED when the
  // revised lines stay within the salesman's limit — the driver just re-pulls
  // the snapshot. If the edit pushes it over the limit it needs re-approval, so
  // it drops to PENDING_APPROVAL and is un-assigned from the driver.
  const wasAssigned = existing.status === OrderStatus.assigned;
  const unassign = wasAssigned && requiresApproval;
  const newStatus: OrderStatus =
    wasAssigned && !requiresApproval
      ? OrderStatus.assigned
      : requiresApproval
        ? OrderStatus.pending_approval
        : OrderStatus.pending;

  const result = await prisma.$transaction(async (tx) => {
    await tx.orderItem.deleteMany({ where: { orderId: id } });
    await tx.orderItem.createMany({
      data: computed.map((c) => ({
        orderId: id,
        productId: c.product.id,
        unitType: c.product.unitType,
        qtyOrdered: c.input.qty,
        unitPrice: c.line.basePrice,
        specialPriceApplied: c.line.specialPrice,
        discountType: c.input.discountType ?? DiscountType.none,
        discountValue: c.input.discountValue != null ? new Prisma.Decimal(c.input.discountValue) : new Prisma.Decimal(0),
        effectiveUnitPrice: c.line.effectiveUnitPrice,
      })),
    });
    const o = await tx.order.update({
      where: { id },
      data: {
        ...(patch.note !== undefined && { note: patch.note }),
        totalValuePkr: totals.subtotal,
        status: newStatus,
        // Over-limit edit of an assigned order → re-approval needed, so release
        // the driver assignment (an unapproved order can't stay assigned).
        ...(unassign && { driverId: null, assignedAt: null, assignedBy: null }),
      },
    });
    // If the new line set requires approval and the old one didn't, create a new approval.
    // If approval is no longer needed, mark any pending approval as approved (auto-cleared).
    if (requiresApproval && existing.status !== OrderStatus.pending_approval) {
      await tx.discountApproval.create({
        data: {
          orderId: id,
          requestedBy: existing.salesmanId,
          status: DiscountApprovalStatus.pending,
        },
      });
    } else if (!requiresApproval && existing.status === OrderStatus.pending_approval) {
      // The edit brought the order within the salesman's limit — auto-clear the
      // pending approval and attribute it to the editor.
      await tx.discountApproval.updateMany({
        where: { orderId: id, status: DiscountApprovalStatus.pending },
        data: {
          status: DiscountApprovalStatus.approved,
          reviewedAt: new Date(),
          reviewedBy: actor.id,
        },
      });
    }
    await recordAudit(
      {
        actor,
        action: 'update',
        entityType: 'order',
        entityId: id,
        oldValue: { status: existing.status, totalValuePkr: existing.totalValuePkr, itemCount: existing.items.length },
        newValue: { status: newStatus, totalValuePkr: totals.subtotal, itemCount: computed.length, requiresApproval },
      },
      tx
    );
    const items = await tx.orderItem.findMany({ where: { orderId: id } });
    return { ...o, items };
  });

  return result;
}

// ─── Assign / Cancel (SRS §3.3, D33, D34) ────────────────────────────────

// Admin assigns a PENDING order to a driver. Sets status=ASSIGNED and stamps
// assigned_at / assigned_by. Driver receives the order on next snapshot
// download or push notification (SRS SM43).
export async function assignOrder(actor: Actor, orderId: string, driverId: string): Promise<Order> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }
  if (order.status !== OrderStatus.pending) {
    throw new HttpError(
      409,
      'ORDER_NOT_ASSIGNABLE',
      `Only PENDING orders can be assigned (this order is ${order.status})`
    );
  }
  const driver = await prisma.user.findUnique({
    where: { id: driverId },
    select: { role: true, isActive: true, isDeleted: true },
  });
  if (!driver || driver.isDeleted || !driver.isActive || driver.role !== Role.driver) {
    throw new HttpError(400, 'INVALID_DRIVER', 'driverId must reference an active driver');
  }
  // A retried order carries the delivery date of its prior failed attempt; the
  // driver snapshot filters strictly on deliveryDate = today, so a stale date
  // would make the reassigned order invisible to every future driver download.
  // Bump it to today on assignment. Fresh orders are assigned on their delivery
  // date already, so this is a no-op for them.
  const today = businessDateOnly();
  const bumpDelivery = order.deliveryDate < today;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.assigned,
        driverId,
        assignedAt: new Date(),
        assignedBy: actor.id,
        ...(bumpDelivery ? { deliveryDate: today } : {}),
      },
    });
    await recordAudit(
      {
        actor,
        action: 'assign',
        entityType: 'order',
        entityId: orderId,
        oldValue: { status: order.status, driverId: order.driverId, deliveryDate: order.deliveryDate },
        newValue: {
          status: OrderStatus.assigned,
          driverId,
          ...(bumpDelivery ? { deliveryDate: today } : {}),
        },
      },
      tx
    );
    return updated;
  });
}

// Bulk assign — admin selects multiple PENDING orders in a zone and pushes
// them to one driver (SRS OR03). Skips any order that isn't currently
// PENDING; returns per-order results so the UI can show "5 of 7 assigned".
export async function assignOrdersBatch(
  actor: Actor,
  orderIds: string[],
  driverId: string
): Promise<{ assigned: string[]; skipped: Array<{ id: string; reason: string }> }> {
  const driver = await prisma.user.findUnique({
    where: { id: driverId },
    select: { role: true, isActive: true, isDeleted: true },
  });
  if (!driver || driver.isDeleted || !driver.isActive || driver.role !== Role.driver) {
    throw new HttpError(400, 'INVALID_DRIVER', 'driverId must reference an active driver');
  }
  const assigned: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of orderIds) {
    try {
      await assignOrder(actor, id, driverId);
      assigned.push(id);
    } catch (err) {
      if (err instanceof HttpError) {
        skipped.push({ id, reason: err.code });
      } else {
        throw err;
      }
    }
  }
  return { assigned, skipped };
}

// SRS D33: Super Admin cancels with a typed reason. Audit-logged.
// CANCELLED is terminal — no further transitions.
export async function cancelOrder(actor: Actor, orderId: string, reason: string): Promise<Order> {
  if (actor.role !== Role.super_admin) {
    throw new HttpError(403, 'CANCEL_REQUIRES_SUPER_ADMIN', 'Only a Super Admin can cancel an order');
  }
  if (!reason.trim()) {
    throw new HttpError(400, 'CANCEL_REASON_REQUIRED', 'A cancellation reason is required');
  }
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }
  // SRS §3.3: CANCELLED is reachable only from PENDING_APPROVAL or PENDING.
  // ASSIGNED orders must finish their state machine via the driver
  // (DELIVERED / PARTIAL / FAILED); a Super Admin override goes through the
  // delivery-override flow, not cancellation.
  if (order.status !== OrderStatus.pending && order.status !== OrderStatus.pending_approval) {
    throw new HttpError(
      409,
      'ORDER_NOT_CANCELLABLE',
      `Cannot cancel an order in status ${order.status} (only PENDING / PENDING_APPROVAL are cancellable)`
    );
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.cancelled },
    });
    // If a pending discount approval exists, mark it rejected with the
    // cancellation reason so the queue clears
    await tx.discountApproval.updateMany({
      where: { orderId, status: DiscountApprovalStatus.pending },
      data: {
        status: DiscountApprovalStatus.rejected,
        rejectionReason: `Order cancelled: ${reason}`,
        reviewedBy: actor.id,
        reviewedAt: new Date(),
      },
    });
    await recordAudit(
      {
        actor,
        action: 'cancel',
        entityType: 'order',
        entityId: orderId,
        oldValue: { status: order.status },
        newValue: { status: OrderStatus.cancelled, reason },
      },
      tx
    );
    return updated;
  });
}
