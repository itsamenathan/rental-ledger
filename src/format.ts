/** Formatting helpers for money, dates and months. */
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const money = (n: number | null | undefined) => (n == null ? "—" : usd.format(n));
export const money0 = (n: number | null | undefined) => (n == null ? "—" : usd0.format(n));
export const moneyCompact = (n: number) => (Math.abs(n) >= 10000 ? "$" + compact.format(n) : usd0.format(n));
export const percent = (n: number | null | undefined, digits = 1) =>
  n == null ? "—" : `${(n * 100).toFixed(digits)}%`;
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
export const monthLabel = (ym: string, style: "short" | "long" = "short") => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString("en-US", { month: style });
};

/** "October 2026" */
export const monthTitle = (ym: string) => `${monthLabel(ym, "long")} ${ym.slice(0, 4)}`;
/** "Oct 2026" */
export const monthShort = (ym: string) => `${monthLabel(ym)} ${ym.slice(0, 4)}`;
export const shiftMonth = (ym: string, n: number) => {
  const i = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
};
export const thisMonth = () => today().slice(0, 7);
/** YYYY-MM-DD for a day in a month, clamped to the month's length (day 31 in February → the 28th/29th). */
export const dateInMonth = (ym: string, day: number) => {
  const last = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  return `${ym}-${String(Math.min(day, last)).padStart(2, "0")}`;
};
/** Current calendar year (read once at load; the app is reloaded far more often than years change). */
export const THIS_YEAR = new Date().getFullYear();
