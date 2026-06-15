// Dependency-free CSV serialization for the Reports Centre (SRS §17.3 / FI09 /
// OR10). Two concerns layered in order:
//   1. CSV-injection guard — a cell that *starts* with a spreadsheet formula
//      trigger (= + - @ or a leading tab/CR) is prefixed with an apostrophe so
//      Excel/LibreOffice render it as text instead of executing it. User-set
//      free-text (retailer names, stock-movement notes, etc.) flows into these
//      exports, so an unguarded `=HYPERLINK(...)` would run in an admin's sheet.
//   2. RFC4180 quoting — quote when the (guarded) cell contains a comma, double
//      quote, or newline, doubling any embedded quotes.

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

export function escapeCsvCell(v: string | number | null | undefined): string {
  let s = v == null ? '' : String(v);
  if (s.length > 0 && FORMULA_TRIGGERS.has(s[0]!)) {
    s = `'${s}`;
  }
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n';
}
