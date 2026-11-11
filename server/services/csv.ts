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
