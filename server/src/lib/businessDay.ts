// Canonical business-day boundary for the whole server.
//
// The operator runs in a single Pakistani city, so "today" means the calendar
// day in Asia/Karachi — NOT the server's local day and NOT UTC. Before this
// helper existed, orders used server-local midnight while driver/warehouse/
// finance/POS/alerts used UTC midnight, so the driver snapshot (deliveryDate =
// today) could miss orders, and activity between 00:00–05:00 PKT was attributed
// to the previous UTC day (duplicate-order 409s on sync, split daily reports).
//
// All boundary math is computed explicitly in the configured timezone via Intl,
// so correctness does NOT depend on the host's TZ env. Override with
// BUSINESS_TIMEZONE (defaults to Asia/Karachi, which has no DST).
//
// Two shapes of value, because the schema mixes column types:
//   • @db.Date columns (orderDate, deliveryDate, shiftDate, …) store a bare
//     calendar date. Prisma serializes them from the JS Date's UTC Y/M/D, so we
//     hand them a Date pinned to 00:00:00 UTC of the local calendar date
//     (businessDateOnly / businessDateBounds / addDays).
//   • timestamptz columns (createdAt, collectedAt, visitedAt, …) store an
//     instant. A day filter on them needs the real moment the local day begins
//     (startOfBusinessDay / businessDayBounds) — e.g. 19:00Z the previous day
//     for Asia/Karachi.

const MS_PER_DAY = 86_400_000;

// Default kept in sync with env.ts (BUSINESS_TIMEZONE). Read at call time so
// tests and config changes take effect without a module reload.
function timezone(): string {
  return process.env['BUSINESS_TIMEZONE'] || 'Asia/Karachi';
}

// Wall-clock calendar parts (month is 1-12) for an instant in the business zone.
function zonedYMD(at: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

// Offset of the business zone from UTC at `at`, in ms (+5h for Asia/Karachi).
// Computed as (wall-clock-read-as-UTC) − (actual UTC instant).
function tzOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone(),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = Number(p.value);
  const asUtc = Date.UTC(map['year']!, map['month']! - 1, map['day']!, map['hour']! % 24, map['minute']!, map['second']!);
  return asUtc - at.getTime();
}

/**
 * @db.Date value for the business calendar date of `at` (00:00:00 UTC of that
 * date). Use for storing/comparing date-only columns.
 */
export function businessDateOnly(at: Date = new Date()): Date {
  const { year, month, day } = zonedYMD(at);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Add `n` whole days to a date-only value (UTC-midnight in, UTC-midnight out). */
export function addDays(dateOnly: Date, n: number): Date {
  return new Date(dateOnly.getTime() + n * MS_PER_DAY);
}

/** Half-open [today, tomorrow) bounds as date-only values, for @db.Date columns. */
export function businessDateBounds(at: Date = new Date()): { gte: Date; lt: Date } {
  const gte = businessDateOnly(at);
  return { gte, lt: addDays(gte, 1) };
}

/**
 * The instant the business day of `at` begins (e.g. 19:00Z the previous day for
 * Asia/Karachi). Use for timestamptz lower bounds ("since start of today").
 */
export function startOfBusinessDay(at: Date = new Date()): Date {
  const dateOnly = businessDateOnly(at);
  // Sample the offset at local noon to avoid any midnight DST-transition edge.
  const noon = new Date(dateOnly.getTime() + 12 * 3_600_000);
  return new Date(dateOnly.getTime() - tzOffsetMs(noon));
}

/** Half-open [start, nextStart) instant bounds, for timestamptz day filters. */
export function businessDayBounds(at: Date = new Date()): { gte: Date; lt: Date } {
  const gte = startOfBusinessDay(at);
  // +25h then snap to the next local midnight: exact for no-DST zones and
  // correct across a DST transition too.
  const lt = startOfBusinessDay(new Date(gte.getTime() + MS_PER_DAY + 3_600_000));
  return { gte, lt };
}

/** 'YYYY-MM-DD' calendar key in the business zone. */
export function businessDayKey(at: Date = new Date()): string {
  const { year, month, day } = zonedYMD(at);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * True iff `key` is a strict, zero-padded 'YYYY-MM-DD' string that names a real
 * calendar date (no '2026-13-99' silent rollover). Used to validate report/POS
 * date params at the controller boundary so a malformed value returns 400, not
 * a 500 from downstream Invalid-Date math.
 */
export function isValidDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Round-trips only if the components didn't roll over (e.g. Feb 30 → Mar 2).
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Parse a 'YYYY-MM-DD' key as a business calendar date → @db.Date value. */
export function businessDateOnlyFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

/** Instant bounds [start, nextStart) for a 'YYYY-MM-DD' business calendar day. */
export function businessDayBoundsFromKey(key: string): { gte: Date; lt: Date } {
  const dateOnly = businessDateOnlyFromKey(key);
  const noon = new Date(dateOnly.getTime() + 12 * 3_600_000);
  const gte = new Date(dateOnly.getTime() - tzOffsetMs(noon));
  const lt = new Date(startOfBusinessDay(new Date(gte.getTime() + MS_PER_DAY + 3_600_000)).getTime());
  return { gte, lt };
}
