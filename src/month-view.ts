/**
 * What the Month page's Transactions card shows: the filter, search, category, sort and layout. They live in the
 * page's URL (so Back, Add entry and a shared link keep them) and are applied here in the browser to the month's
 * entries. The search and the filters mean the same as the API's `q`, `kind`, `needs_review`, `needs_receipt` and
 * `category`, so "Export CSV" can send them and download what is on screen.
 */
import type { Transaction } from "./api.ts";

export type Tx = Transaction;
export type TxShow = "all" | "income" | "expense" | "review" | "receipt";
export type TxLayout = "list" | "category";

export interface MonthView {
  show: TxShow;
  q: string;
  /** category id */
  cat: number | null;
  /** date order: oldest first (default) or newest first */
  sort: "asc" | "desc";
  /** null = the saved choice for this device */
  layout: TxLayout | null;
}

const SHOWS: TxShow[] = ["all", "income", "expense", "review", "receipt"];
export const VIEW_KEYS = ["show", "q", "cat", "sort", "view"] as const;

export function readView(p: URLSearchParams): MonthView {
  const show = p.get("show") as TxShow;
  const view = p.get("view");
  const cat = Number(p.get("cat"));
  return {
    show: SHOWS.includes(show) ? show : "all",
    q: p.get("q") ?? "",
    cat: Number.isInteger(cat) && cat > 0 ? cat : null,
    sort: p.get("sort") === "desc" ? "desc" : "asc",
    layout: view === "list" || view === "category" ? view : null,
  };
}

/** A copy of the params with the given parts of the view changed; defaults are left out of the URL. */
export function withView(p: URLSearchParams, patch: Partial<MonthView>): URLSearchParams {
  const v = { ...readView(p), ...patch };
  const next = new URLSearchParams(p);
  const set = (k: string, val: string | null) => (val ? next.set(k, val) : next.delete(k));
  set("show", v.show === "all" ? null : v.show);
  set("q", v.q.trim() ? v.q : null);
  set("cat", v.cat ? String(v.cat) : null);
  set("sort", v.sort === "desc" ? "desc" : null);
  set("view", v.layout);
  return next;
}

/** The view parts of the params as a query string ("?show=expense"), for links to other months. */
export function viewSearch(p: URLSearchParams): string {
  const keep = new URLSearchParams();
  for (const k of VIEW_KEYS) if (p.has(k)) keep.set(k, p.get(k)!);
  const s = keep.toString();
  return s ? `?${s}` : "";
}

/** Something other than "everything, oldest first" is narrowing the list. */
export const isNarrowed = (v: MonthView) => v.show !== "all" || v.q.trim() !== "" || v.cat != null;

const SHOW_TEST: Record<TxShow, (t: Tx) => boolean> = {
  all: () => true,
  income: (t) => t.kind === "income",
  expense: (t) => t.kind === "expense",
  review: (t) => t.needs_review,
  receipt: (t) => !!t.needs_receipt,
};
export const showCount = (items: Tx[], show: TxShow) => items.filter(SHOW_TEST[show]).length;

/** Same rules as the API search: text in the usual fields, an entry number, or "42.50" / "70" as an amount. */
export function matchesSearch(t: Tx, raw: string): boolean {
  const q = raw.trim();
  if (!q) return true;
  const lower = q.toLowerCase();
  const text = [t.description, t.vendor, t.subcategory, t.reference, t.category];
  if (text.some((f) => f.toLowerCase().includes(lower))) return true;
  if (String(t.id) === q) return true;
  if (/^\$?[\d,]*\.?\d+$/.test(q)) {
    const s = q.replace(/[$,\s]/g, "");
    const want = Math.round(Number(s) * 100);
    const have = Math.round(Math.abs(t.amount) * 100);
    return s.includes(".") ? have === want : have >= want && have <= want + 99;
  }
  return false;
}

export function applyView(items: Tx[], v: MonthView): Tx[] {
  const out = items.filter(
    (t) => SHOW_TEST[v.show](t) && (v.cat == null || t.category_id === v.cat) && matchesSearch(t, v.q),
  );
  // the month arrives oldest first
  return v.sort === "desc" ? out.reverse() : out;
}

/** The API filters for the same view (for the CSV export). */
export function exportFilters(v: MonthView): Record<string, string | undefined> {
  return {
    kind: v.show === "income" || v.show === "expense" ? v.show : undefined,
    needs_review: v.show === "review" ? "true" : undefined,
    needs_receipt: v.show === "receipt" ? "true" : undefined,
    category: v.cat ? String(v.cat) : undefined,
    q: v.q.trim() || undefined,
    sort: v.sort === "desc" ? "date_desc" : "date_asc",
  };
}

/** The pieces of an entry's name, without saying the same thing twice ("Airbnb · Airbnb · 4-night stay"). */
export function txParts(t: Pick<Tx, "vendor" | "subcategory" | "description" | "category">) {
  const seen = new Set<string>();
  const parts = [t.vendor, t.subcategory, t.description].filter((x) => {
    const k = x.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { main: parts[0] ?? t.category, rest: parts.slice(1), hasName: parts.length > 0 };
}
