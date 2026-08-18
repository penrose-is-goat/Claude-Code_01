/**
 * ExcelJS has no autofit — the single most-hit gotcha in the library. Approximating it
 * from content length is close enough that nobody notices, and the clamp stops one long
 * description from producing a 300-character column.
 */
export function computeWidth(header: string, values: unknown[], min = 8, max = 60): number {
  let longest = header.length;
  for (const v of values) {
    if (v == null) continue;
    const len = String(v).length;
    if (len > longest) longest = len;
  }
  return Math.min(max, Math.max(min, Math.round(longest * 1.15) + 2));
}

export function applyAutoWidth(
  worksheet: { columns: Array<{ header?: unknown; width?: number; key?: string }> },
  rows: Array<Record<string, unknown>>,
): void {
  for (const col of worksheet.columns) {
    if (!col.key) continue;
    const header = typeof col.header === 'string' ? col.header : String(col.header ?? '');
    col.width = computeWidth(header, rows.map((r) => r[col.key!]));
  }
}
