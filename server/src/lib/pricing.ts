import { Prisma, DiscountType } from '@prisma/client';

// Pure pricing functions, no DB access. The service layer loads the rows
// and these functions decide what gets charged. Server-side authority per
// SRS §15.2 — clients run the same math for UX but the server re-evaluates
// every order on submission and rejects anything below the floor.

export type LineInput = {
  basePrice: Prisma.Decimal | number | string;
  specialPrice?: Prisma.Decimal | number | string | null;
  discountType: DiscountType;
  // Percent (0–100) when discountType=pct, PKR amount per unit when discountType=pkr
  discountValue: Prisma.Decimal | number | string;
  qty: number;
};

export type LineResult = {
  basePrice: Prisma.Decimal;
  specialPrice: Prisma.Decimal | null;
  floor: Prisma.Decimal;
  discountedUnitPrice: Prisma.Decimal; // base - discount, BEFORE clamping to floor
  effectiveUnitPrice: Prisma.Decimal;
  qty: number;
  lineTotal: Prisma.Decimal;
  discountAmountPerUnit: Prisma.Decimal;
  // True if the requested discount would have pushed price below the floor
  // and was clamped — the salesman gets less benefit than they typed
  clampedToFloor: boolean;
};

function toDecimal(v: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal {
  if (v == null) return new Prisma.Decimal(0);
  return v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);
}

// SRS §11 three-layer pricing rule:
//   effective = max(special_price OR base_price, base_price - discount)
// i.e. the floor is the special_price when it exists, otherwise the base_price.
// With no special price the floor equals the base, so a discount only takes
// effect for retailers the admin has explicitly priced via retailer_prices.
export function computeLine(input: LineInput): LineResult {
  const base = toDecimal(input.basePrice);
  const special = input.specialPrice != null ? toDecimal(input.specialPrice) : null;
  const value = toDecimal(input.discountValue);
  const qty = input.qty;

  let discountPerUnit: Prisma.Decimal;
  switch (input.discountType) {
    case DiscountType.pct:
      discountPerUnit = base.mul(value).div(100);
      break;
    case DiscountType.pkr:
      discountPerUnit = value;
      break;
    case DiscountType.none:
    default:
      discountPerUnit = new Prisma.Decimal(0);
  }

  const discounted = base.sub(discountPerUnit);
  const floor = special ?? base;
  const effective = Prisma.Decimal.max(floor, discounted);
  const clamped = discounted.lt(floor);

  return {
    basePrice: base,
    specialPrice: special,
    floor,
    discountedUnitPrice: discounted,
    effectiveUnitPrice: effective,
    qty,
    lineTotal: effective.mul(qty),
    discountAmountPerUnit: discountPerUnit,
    clampedToFloor: clamped,
  };
}

/**
 * PRICE-1 / SRS §5.1: did the server's authoritative recompute change the line
 * price the salesman captured offline? Used to set order_items.price_revised_on_sync
 * so the salesman can be notified of the X→Y delta. Compared at 2 d.p. (PKR);
 * returns false when the client supplied no captured price (nothing to diff).
 */
export function priceWasRevised(
  serverEffectiveUnitPrice: Prisma.Decimal,
  capturedUnitPrice?: number | string | null
): boolean {
  if (capturedUnitPrice == null) return false;
  const captured = new Prisma.Decimal(capturedUnitPrice).toDecimalPlaces(2);
  return !serverEffectiveUnitPrice.toDecimalPlaces(2).equals(captured);
}

export type OrderTotalsInput = {
  lines: LineResult[];
};

export type OrderTotals = {
  subtotal: Prisma.Decimal; // Sum of lineTotal across lines
  totalDiscountPkr: Prisma.Decimal; // Sum of (base*qty - effective*qty) across lines
};

export function computeOrderTotals({ lines }: OrderTotalsInput): OrderTotals {
  let subtotal = new Prisma.Decimal(0);
  let totalDiscount = new Prisma.Decimal(0);
  for (const line of lines) {
    subtotal = subtotal.add(line.lineTotal);
    const lineBaseTotal = line.basePrice.mul(line.qty);
    totalDiscount = totalDiscount.add(lineBaseTotal.sub(line.lineTotal));
  }
  return { subtotal, totalDiscountPkr: totalDiscount };
}

export type SalesmanLimit = {
  maxDiscountPct: Prisma.Decimal | number | string | null;
  maxDiscountPkr: Prisma.Decimal | number | string | null;
};

// SRS D13: discount within salesman limit → instant PENDING; above limit
// → PENDING_APPROVAL. Limits are both checkable individually: if either is
// breached, approval is required. A null limit on a side means that side
// is unconstrained.
export type ApprovalCheck = {
  requiresApproval: boolean;
  reason?: 'pct_exceeded' | 'pkr_exceeded';
  // Largest single-line discount the salesman applied, in percent terms
  maxLinePct: Prisma.Decimal;
  // Total PKR discount across the order
  totalPkr: Prisma.Decimal;
};

export function checkSalesmanDiscountLimit(
  limit: SalesmanLimit,
  lines: LineResult[]
): ApprovalCheck {
  let maxLinePct = new Prisma.Decimal(0);
  let totalPkr = new Prisma.Decimal(0);
  for (const line of lines) {
    const lineBaseTotal = line.basePrice.mul(line.qty);
    const lineDiscountPkr = lineBaseTotal.sub(line.lineTotal);
    totalPkr = totalPkr.add(lineDiscountPkr);
    if (line.basePrice.gt(0)) {
      const pct = line.basePrice.sub(line.effectiveUnitPrice).div(line.basePrice).mul(100);
      if (pct.gt(maxLinePct)) maxLinePct = pct;
    }
  }
  const pctLimit = limit.maxDiscountPct != null ? toDecimal(limit.maxDiscountPct) : null;
  const pkrLimit = limit.maxDiscountPkr != null ? toDecimal(limit.maxDiscountPkr) : null;

  if (pctLimit != null && maxLinePct.gt(pctLimit)) {
    return { requiresApproval: true, reason: 'pct_exceeded', maxLinePct, totalPkr };
  }
  if (pkrLimit != null && totalPkr.gt(pkrLimit)) {
    return { requiresApproval: true, reason: 'pkr_exceeded', maxLinePct, totalPkr };
  }
  return { requiresApproval: false, maxLinePct, totalPkr };
}
