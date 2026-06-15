import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { businessDateOnly } from '../lib/businessDay';
import { attributeOrderDate } from './orders.service';
import { resolveShiftDate } from './driver.service';

before(() => {
  process.env['BUSINESS_TIMEZONE'] = 'Asia/Karachi';
});

// Fixed "today" = the PKT business day of this instant (2026-06-10).
const TODAY = businessDateOnly(new Date('2026-06-10T08:00:00Z'));
const iso = (d: Date): string => d.toISOString();

// ─── #7 order capture-date attribution ───────────────────────────────────

test('no capture date → order belongs to the sync (today) day', () => {
  assert.equal(iso(attributeOrderDate(undefined, TODAY)), '2026-06-10T00:00:00.000Z');
});

test('captured today (synced same day) → honor capture day', () => {
  // 2026-06-10 23:50 PKT == 2026-06-10 18:50 UTC.
  assert.equal(iso(attributeOrderDate('2026-06-10T18:50:00Z', TODAY)), '2026-06-10T00:00:00.000Z');
});

test('captured yesterday, synced today (delivery day already arrived) → re-date to sync day', () => {
  // 2026-06-09 15:00 PKT; capture+1 = Jun 10 = today, so the next-day slot is
  // gone → order belongs to today (Jun 10), delivers Jun 11.
  assert.equal(iso(attributeOrderDate('2026-06-09T10:00:00Z', TODAY)), '2026-06-10T00:00:00.000Z');
});

test('captured two days ago → re-date to sync day (well past the delivery slot)', () => {
  assert.equal(iso(attributeOrderDate('2026-06-08T10:00:00Z', TODAY)), '2026-06-10T00:00:00.000Z');
});

test('future capture date (device clock skew) is clamped to today', () => {
  assert.equal(iso(attributeOrderDate('2026-06-12T10:00:00Z', TODAY)), '2026-06-10T00:00:00.000Z');
});

test('cross-midnight: captured 00:30 PKT honors that capture day when synced same day', () => {
  // Captured 2026-06-10 00:30 PKT (== 2026-06-09 19:30 UTC) and synced the same
  // PKT day → capture day is Jun 10, delivery Jun 11: honored.
  assert.equal(iso(attributeOrderDate('2026-06-09T19:30:00Z', TODAY)), '2026-06-10T00:00:00.000Z');
});

// ─── driver shift-date resolution (after-midnight drain) ──────────────────

test('no shift key → today', () => {
  assert.equal(iso(resolveShiftDate(undefined, TODAY)), '2026-06-10T00:00:00.000Z');
});

test('shift key = today → today', () => {
  assert.equal(iso(resolveShiftDate('2026-06-10', TODAY)), '2026-06-10T00:00:00.000Z');
});

test('shift key = yesterday (queued offline, drained after midnight) → yesterday', () => {
  assert.equal(iso(resolveShiftDate('2026-06-09', TODAY)), '2026-06-09T00:00:00.000Z');
});

test('shift key older than yesterday is ignored → today', () => {
  assert.equal(iso(resolveShiftDate('2026-06-01', TODAY)), '2026-06-10T00:00:00.000Z');
});

test('shift key in the future is ignored → today', () => {
  assert.equal(iso(resolveShiftDate('2026-06-20', TODAY)), '2026-06-10T00:00:00.000Z');
});
