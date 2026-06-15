import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  addDays,
  businessDateBounds,
  businessDateOnly,
  businessDateOnlyFromKey,
  businessDayBounds,
  businessDayBoundsFromKey,
  businessDayKey,
  isValidDateKey,
  startOfBusinessDay,
} from './businessDay';

// Pin the zone so the suite is deterministic regardless of the host's TZ.
before(() => {
  process.env['BUSINESS_TIMEZONE'] = 'Asia/Karachi';
});

const iso = (d: Date): string => d.toISOString();

test('businessDateOnly maps a PKT-evening instant to the same calendar date', () => {
  // 2026-06-09 23:00 PKT == 2026-06-09 18:00 UTC → still June 9 locally.
  assert.equal(iso(businessDateOnly(new Date('2026-06-09T18:00:00Z'))), '2026-06-09T00:00:00.000Z');
});

test('businessDateOnly rolls to the next date at PKT midnight, not UTC midnight', () => {
  // 2026-06-10 00:00 PKT == 2026-06-09 19:00 UTC → June 10 locally.
  assert.equal(iso(businessDateOnly(new Date('2026-06-09T19:00:00Z'))), '2026-06-10T00:00:00.000Z');
  // 2026-06-10 01:00 PKT == 2026-06-09 20:00 UTC → June 10 locally (the bug
  // window: old UTC logic wrongly attributed this to June 9).
  assert.equal(iso(businessDateOnly(new Date('2026-06-09T20:00:00Z'))), '2026-06-10T00:00:00.000Z');
});

test('businessDateOnly: 04:59 PKT is still "today", 00:00 UTC would have been wrong', () => {
  // 2026-06-10 04:59 PKT == 2026-06-09 23:59 UTC. Under UTC this is June 9;
  // under PKT it is correctly June 10.
  assert.equal(iso(businessDateOnly(new Date('2026-06-09T23:59:00Z'))), '2026-06-10T00:00:00.000Z');
});

test('startOfBusinessDay returns the PKT-midnight instant (19:00Z prior day)', () => {
  assert.equal(iso(startOfBusinessDay(new Date('2026-06-10T08:00:00Z'))), '2026-06-09T19:00:00.000Z');
});

test('businessDayBounds is a 24h half-open instant window starting at PKT midnight', () => {
  const { gte, lt } = businessDayBounds(new Date('2026-06-10T08:00:00Z'));
  assert.equal(iso(gte), '2026-06-09T19:00:00.000Z');
  assert.equal(iso(lt), '2026-06-10T19:00:00.000Z');
  assert.equal(lt.getTime() - gte.getTime(), 86_400_000);
});

test('businessDateBounds is a half-open date-only window for @db.Date columns', () => {
  const { gte, lt } = businessDateBounds(new Date('2026-06-10T08:00:00Z'));
  assert.equal(iso(gte), '2026-06-10T00:00:00.000Z');
  assert.equal(iso(lt), '2026-06-11T00:00:00.000Z');
});

test('addDays advances a date-only value by exact UTC days', () => {
  const base = businessDateOnly(new Date('2026-06-10T08:00:00Z'));
  assert.equal(iso(addDays(base, 1)), '2026-06-11T00:00:00.000Z');
  assert.equal(iso(addDays(base, -2)), '2026-06-08T00:00:00.000Z');
});

test('businessDayKey is the PKT calendar date string', () => {
  assert.equal(businessDayKey(new Date('2026-06-09T20:00:00Z')), '2026-06-10');
  assert.equal(businessDayKey(new Date('2026-06-09T18:00:00Z')), '2026-06-09');
});

test('businessDateOnlyFromKey parses a key as a local calendar date', () => {
  assert.equal(iso(businessDateOnlyFromKey('2026-06-10')), '2026-06-10T00:00:00.000Z');
});

test('businessDayBoundsFromKey yields the instant window for that local day', () => {
  const { gte, lt } = businessDayBoundsFromKey('2026-06-10');
  assert.equal(iso(gte), '2026-06-09T19:00:00.000Z');
  assert.equal(iso(lt), '2026-06-10T19:00:00.000Z');
});

test('round-trip: an order created at 01:00 PKT shares the day of a POS sale at 23:00 PKT', () => {
  // The whole point of the keystone: a field order synced just after midnight
  // PKT and a POS sale late the prior evening must NOT collide on day math.
  const order = businessDateOnly(new Date('2026-06-09T20:00:00Z')); // 01:00 PKT Jun 10
  const posDay = businessDateOnly(new Date('2026-06-09T18:00:00Z')); // 23:00 PKT Jun 9
  assert.equal(iso(order), '2026-06-10T00:00:00.000Z');
  assert.equal(iso(posDay), '2026-06-09T00:00:00.000Z');
  assert.notEqual(order.getTime(), posDay.getTime());
});

// ─── VAL-1: strict date-key validation (reject malformed report/POS params) ──
test('isValidDateKey accepts a well-formed calendar key', () => {
  assert.equal(isValidDateKey('2026-06-12'), true);
  assert.equal(isValidDateKey('2024-02-29'), true); // leap day
});

test('isValidDateKey rejects non-date and malformed strings', () => {
  assert.equal(isValidDateKey('foo'), false);
  assert.equal(isValidDateKey(''), false);
  assert.equal(isValidDateKey('2026-6-1'), false); // not zero-padded
  assert.equal(isValidDateKey('2026/06/12'), false);
  assert.equal(isValidDateKey('2026-06-12T00:00:00Z'), false);
});

test('isValidDateKey rejects out-of-range months/days (no silent rollover)', () => {
  assert.equal(isValidDateKey('2026-13-99'), false);
  assert.equal(isValidDateKey('2026-00-10'), false);
  assert.equal(isValidDateKey('2026-02-30'), false);
  assert.equal(isValidDateKey('2026-04-31'), false);
});
