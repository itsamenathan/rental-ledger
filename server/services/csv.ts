export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const esc = (v: unknown) => {
    if (v == null) return "";
    let s = typeof v === "object" ? JSON.stringify(v) : String(v as string);
    // Neutralize spreadsheet formula injection (but keep negative numbers intact).
    if (/^[=+@\t\r]/.test(s) || (s.startsWith("-") && Number.isNaN(Number(s)))) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

export const TRANSACTION_COLUMNS = [
  "id",
  "date",
  "property",
  "amount",
  "kind",
  "category",
  "subcategory",
  "vendor",
  "allocation",
  "schedule_e_line",
  "description",
  "account",
  "reference",
  "attachment_count",
  "needs_review",
  "source",
];

/** Transactions (as returned by listTransactions) as a spreadsheet-safe CSV. */
export function transactionsCsv(items: object[]) {
  return toCsv(items as Record<string, unknown>[], TRANSACTION_COLUMNS);
}

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF). Blank rows are dropped. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endRow = () => {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
    field = "";
  };
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else field += ch;
  }
  endRow();
  return rows;
}
