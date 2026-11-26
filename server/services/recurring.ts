/**
 * Recurring-transaction detection. Learns bills from history (no setup): transactions are grouped into series by
 * property + category + vendor + subcategory, a series whose recent months follow a steady cadence (monthly,
 * every 2/3/4/6 months, yearly) is treated as recurring, and gaps in that cadence are reported as missing.
 * User feedback (ignore a series, or "nothing was due this month") is stored in recurring_dismissals.
 */
import { and, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db.ts";
import { categories, recurringDismissals, transactions } from "../db/schema.ts";
import { audit, badRequest, notFound, requireWrite, type Actor } from "../context.ts";

const CADENCES = [1, 2, 3, 4, 6, 12] as const;
const CADENCE_LABEL: Record<number, string> = {
  1: "Monthly",
  2: "Every 2 months",
  3: "Quarterly",
  4: "Every 4 months",
  6: "Twice a year",
  12: "Yearly",
};
/** How far back to learn from. */
const HISTORY_MONTHS = 36;
/** Share of expected payments (over the last year, or 3 cycles) that must be present to call a series recurring. */
const MIN_COVERAGE = 0.75;

type Status = "ok" | "due" | "missing" | "stopped" | "ignored";

export interface SeriesMonth {
  month: string;
  amount: number;
  count: number;
  ids: number[];
  dates: string[];
  amounts: number[];
}

export interface Series {
  key: string;
  label: string;
  property_id: number;
  category_id: number;
  category: string;
  kind: "income" | "expense";
  vendor: string;
  subcategory: string;
  allocation: "direct" | "indirect" | null;
  cadence: number;
  cadence_label: string;
  occurrences: number;
  first_date: string;
  last_date: string;
  last_amount: number;
  typical_amount: number;
  fixed_amount: boolean;
  expected_day: number;
  next_due: string;
  status: Status;
  missing_months: string[];
  /** Months inside the series' schedule (regime start → today) */
  expected_months: string[];
  history: SeriesMonth[];
}

export interface RecurringAlert {
  level: "warning" | "info";
  type: "missing" | "duplicate" | "amount_changed" | "unusual";
  series_key: string;
  label: string;
  month: string;
  message: string;
  expected_amount: number;
  ids?: number[];
}

// ---------- month arithmetic ----------
const monthIdx = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const idxMonth = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const daysIn = (i: number) => new Date(Date.UTC(Math.floor(i / 12), (i % 12) + 1, 0)).getUTCDate();
const dateIn = (i: number, day: number) => `${idxMonth(i)}-${String(Math.min(day, daysIn(i))).padStart(2, "0")}`;
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};
const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const norm = (s: string) => s.trim().toLowerCase();
const MONTH_NAMES = "January February March April May June July August September October November December".split(" ");
/** "2026-08" → "August 2026" */
const monthName = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
/** "2026-08-05" → "Aug 5" */
const shortDate = (iso: string) =>
  `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]!.slice(0, 3)} ${Number(iso.slice(8, 10))}`;
const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const whenInMonth = (day: number) => (day >= 28 ? "at month end" : `around the ${ordinal(day)}`);

export const seriesKey = (propertyId: number, categoryId: number, vendor: string, subcategory: string) =>
  `${propertyId}:${categoryId}:${norm(vendor)}:${norm(subcategory)}`;

/**
 * A series is named the way its entries are (`txParts` in src/month-view.ts): vendor, then subcategory, without saying
 * the same thing twice ("Example Fiber · Internet", "Acme PM"); the category only when there's nothing else.
 */
function labelOf(category: string, vendor: string, subcategory: string) {
  const parts = [vendor.trim(), subcategory.trim()].filter(Boolean);
  if (parts.length === 2 && norm(parts[0]!) === norm(parts[1]!)) parts.pop();
  return parts.length ? parts.join(" · ") : category;
}

/** Grace period after a due date before a payment counts as missing. */
const graceDays = (cadence: number) => (cadence === 1 ? 10 : 21);

interface Row {
  id: number;
  propertyId: number;
  date: string;
  amountCents: number;
  categoryId: number;
  category: string;
  kind: "income" | "expense";
  vendor: string;
  subcategory: string;
  allocation: "direct" | "indirect" | null;
}

function analyze(rows: Row[], today: string, dismissed: Map<string, Set<string>>): Series | null {
  const byMonth = new Map<number, Row[]>();
  for (const r of rows) {
    const i = monthIdx(r.date);
    byMonth.set(i, [...(byMonth.get(i) ?? []), r]);
  }
  const months = [...byMonth.keys()].sort((a, b) => a - b);
  if (months.length < 3) return null;

  // Cadence = median of the recent gaps, if the latest gaps agree with it.
  const gaps = months.slice(1).map((m, i) => m - months[i]!);
  const p = median(gaps.slice(-6));
  if (!(CADENCES as readonly number[]).includes(p)) return null;
  // Quarterly and longer bills drift by a month (e.g. a Jan 15 tax paid Dec 28), so allow ±1 month there.
  const tol = p >= 3 ? 1 : 0;
  const fits = (g: number) => Math.abs(g - p) <= tol;
  const latestGaps = gaps.slice(-4);
  if (latestGaps.filter(fits).length / latestGaps.length < 0.75) return null;

  // Walk back from the latest payment one cycle at a time. Each step either lands on a payment (within ±tol) or
  // is a hole. The schedule starts at the earliest payment before a run of 3 holes; holes inside it are missing.
  const present = new Set(months);
  const lastIdx = months[months.length - 1]!;
  const nearest = (i: number) =>
    [0, -1, 1]
      .slice(0, 2 * tol + 1)
      .map((d) => i + d)
      .find((j) => present.has(j));
  const grid: { idx: number; hit: boolean }[] = [];
  for (let i = lastIdx, holes = 0; i >= months[0]! - tol && holes < 3;) {
    const h = nearest(i);
    if (h !== undefined) {
      grid.unshift({ idx: h, hit: true });
      holes = 0;
      i = h - p;
    } else {
      grid.unshift({ idx: i, hit: false });
      holes++;
      i -= p;
    }
  }
  while (grid.length && !grid[0]!.hit) grid.shift();
  const regime = grid.filter((g) => g.hit).map((g) => g.idx);
  if (regime.length < (p === 1 ? 3 : 4)) return null;

  // Coverage over the last year (at least 3 cycles): most expected payments must be there. Rejects things that
  // bunch up seasonally (e.g. booking fees) or one-off purchases that happen to line up.
  const windowStart = Math.max(months[0]!, monthIdx(today) - Math.max(12, 3 * p));
  let steps = 0;
  let hits = 0;
  for (let i = lastIdx; i >= windowStart; i -= p) {
    steps++;
    const h = nearest(i);
    if (h !== undefined) {
      hits++;
      i = h;
    }
  }
  if (steps < 3 || hits / steps < MIN_COVERAGE) return null;

  const first = rows[0]!;
  const latest = rows[rows.length - 1]!;
  const key = seriesKey(first.propertyId, first.categoryId, first.vendor, first.subcategory);
  const skip = dismissed.get(key) ?? new Set<string>();

  const sums = regime.map((m) => byMonth.get(m)!.reduce((a, r) => a + r.amountCents, 0));
  const last3 = sums.slice(-3);
  const typical = median(last3);
  const fixed = last3.every((s) => s === last3[0]);
  const expectedDay = median(
    regime.slice(-3).map((m) => Math.max(...byMonth.get(m)!.map((r) => Number(r.date.slice(8, 10))))),
  );

  // Holes in the schedule, then cycles after the latest payment whose due date (+ grace) has passed.
  const todayIdx = monthIdx(today);
  const missing = grid
    .filter((g) => !g.hit && addDays(dateIn(g.idx, expectedDay), graceDays(p)) < today)
    .map((g) => g.idx);
  const expected = grid.map((g) => g.idx);
  let nextIdx = lastIdx + p;
  for (; nextIdx <= todayIdx; nextIdx += p) {
    expected.push(nextIdx);
    if (addDays(dateIn(nextIdx, expectedDay), graceDays(p)) >= today) break;
    missing.push(nextIdx);
  }
  const nextDue = dateIn(nextIdx, expectedDay);

  const liveMissing = missing.filter((i) => !skip.has(idxMonth(i)));
  const missedSinceLast = missing.filter((i) => i > lastIdx).length;
  let status: Status = "ok";
  if (skip.has("")) status = "ignored";
  else if (missedSinceLast >= 3) status = "stopped";
  else if (liveMissing.length) status = "missing";
  else if (nextDue <= today) status = "due";

  return {
    key,
    label: labelOf(latest.category, latest.vendor, latest.subcategory),
    property_id: first.propertyId,
    category_id: first.categoryId,
    category: latest.category,
    kind: latest.kind,
    vendor: latest.vendor,
    subcategory: latest.subcategory,
    allocation: latest.allocation,
    cadence: p,
    cadence_label: CADENCE_LABEL[p]!,
    occurrences: regime.reduce((a, m) => a + byMonth.get(m)!.length, 0),
    first_date: byMonth.get(regime[0]!)![0]!.date,
    last_date: latest.date,
    last_amount: sums[sums.length - 1]! / 100,
    typical_amount: typical / 100,
    fixed_amount: fixed,
    expected_day: expectedDay,
    next_due: nextDue,
    status,
    missing_months: liveMissing.map(idxMonth),
    expected_months: expected.map(idxMonth),
    history: months.map((m) => {
      const rs = byMonth.get(m)!;
      return {
        month: idxMonth(m),
        amount: rs.reduce((a, r) => a + r.amountCents, 0) / 100,
        count: rs.length,
        ids: rs.map((r) => r.id),
        dates: rs.map((r) => r.date),
        amounts: rs.map((r) => r.amountCents / 100),
      };
    }),
  };
}

function alertsFor(s: Series, today: string, skip: Set<string>): RecurringAlert[] {
  if (s.status === "ignored" || s.status === "stopped") return [];
  const out: RecurringAlert[] = [];
  // Report back to January of last year: anything older has already gone to the tax preparer.
  const windowStart = `${Number(today.slice(0, 4)) - 1}-01`;
  const base = { series_key: s.key, label: s.label, expected_amount: s.typical_amount };
  const amt = (n: number) => money(n * 100);

  for (const m of s.missing_months.filter((m) => m >= windowStart))
    out.push({
      ...base,
      level: "warning",
      type: "missing",
      month: m,
      message: `No ${s.label} recorded for ${monthName(m)}. It's usually about ${amt(s.typical_amount)} ${whenInMonth(s.expected_day)}.`,
    });

  // Duplicates: a once-a-cycle expense recorded twice in a month for the exact same amount.
  const expected = new Set(s.expected_months);
  const typicalCount = median(s.history.filter((h) => expected.has(h.month)).map((h) => h.count));
  if (s.kind === "expense" && typicalCount === 1)
    for (const h of s.history) {
      if (h.month < windowStart || skip.has(h.month) || h.count < 2) continue;
      const amounts = h.amounts;
      const dupAmount = amounts.find((a, i) => amounts.indexOf(a) !== i);
      if (dupAmount === undefined) continue;
      out.push({
        ...base,
        level: "warning",
        type: "duplicate",
        month: h.month,
        ids: h.ids.filter((_, i) => amounts[i] === dupAmount),
        message: `${s.label} was recorded twice in ${monthName(h.month)} for ${amt(dupAmount)} (${h.dates
          .filter((_, i) => amounts[i] === dupAmount)
          .map(shortDate)
          .join(" and ")}). Possible duplicate.`,
      });
    }

  // Amount checks on the latest payment only, and only if it's recent.
  const inSchedule = s.history.filter((h) => expected.has(h.month));
  const last = inSchedule[inSchedule.length - 1];
  const prev = inSchedule.slice(-7, -1).map((h) => h.amount);
  if (last && prev.length >= 3 && last.month >= idxMonth(monthIdx(today) - 2) && !skip.has(last.month)) {
    const prevFixed = prev.slice(-3).every((a) => a === prev[prev.length - 1]);
    const usual = median(prev.map(Math.abs));
    if (prevFixed && last.amount !== prev[prev.length - 1])
      out.push({
        ...base,
        level: "info",
        type: "amount_changed",
        month: last.month,
        ids: last.ids,
        message: `${s.label} changed from ${amt(prev[prev.length - 1]!)} to ${amt(last.amount)} in ${monthName(last.month)}.`,
      });
    else if (!prevFixed && Math.abs(last.amount) > usual * 1.5 && Math.abs(last.amount) - usual > 50)
      out.push({
        ...base,
        level: "info",
        type: "unusual",
        month: last.month,
        ids: last.ids,
        message: `${s.label} was ${amt(last.amount)} in ${monthName(last.month)}, well above the usual ${amt(usual)}.`,
      });
  }
  return out;
}

function loadDismissals(db: DB) {
  const map = new Map<string, Set<string>>();
  for (const d of db.select().from(recurringDismissals).all()) {
    if (!map.has(d.seriesKey)) map.set(d.seriesKey, new Set());
    map.get(d.seriesKey)!.add(d.month);
  }
  return map;
}

export interface RecurringOptions {
  propertyId?: number;
  /** YYYY-MM-DD; defaults to the current date */
  today?: string;
}

/** All detected recurring series plus alerts (missing payments, duplicates, amount changes). */
export function recurring(db: DB, opts: RecurringOptions = {}) {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const since = `${idxMonth(monthIdx(today) - HISTORY_MONTHS)}-01`;
  const t = transactions;
  const rows = db
    .select({
      id: t.id,
      propertyId: t.propertyId,
      date: t.date,
      amountCents: t.amountCents,
      categoryId: t.categoryId,
      category: categories.name,
      kind: categories.kind,
      vendor: t.vendor,
      subcategory: t.subcategory,
      allocation: t.allocation,
    })
    .from(t)
    .innerJoin(categories, eq(categories.id, t.categoryId))
    .where(
      and(isNull(t.deletedAt), gte(t.date, since), opts.propertyId ? eq(t.propertyId, opts.propertyId) : undefined),
    )
    .orderBy(t.date, t.id)
    .all();

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = seriesKey(r.propertyId, r.categoryId, r.vendor, r.subcategory);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const dismissed = loadDismissals(db);
  const series = [...groups.values()]
    .map((g) => analyze(g, today, dismissed))
    .filter((s): s is Series => s !== null)
    .sort((a, b) => a.label.localeCompare(b.label));
  const alerts = series
    .flatMap((s) => alertsFor(s, today, dismissed.get(s.key) ?? new Set()))
    .sort((a, b) => (a.level === b.level ? b.month.localeCompare(a.month) : a.level === "warning" ? -1 : 1));
  const dismissals = db
    .select({
      id: recurringDismissals.id,
      series_key: recurringDismissals.seriesKey,
      month: recurringDismissals.month,
      note: recurringDismissals.note,
      created_at: recurringDismissals.createdAt,
    })
    .from(recurringDismissals)
    .all();
  return { today, series, alerts, dismissals };
}

/** For one month: each recurring series expected (or paid) that month, and whether it was found. */
export function monthChecklist(db: DB, ym: string, opts: RecurringOptions = {}) {
  const { series, alerts, today } = recurring(db, opts);
  const items = series
    .filter((s) => s.status !== "ignored")
    .map((s) => {
      const h = s.history.find((x) => x.month === ym);
      const expected = s.expected_months.includes(ym) || (s.next_due.slice(0, 7) === ym && s.status !== "stopped");
      if (!h && !expected) return null;
      let state: "paid" | "missing" | "upcoming" | "skipped" = "paid";
      if (!h) {
        if (s.missing_months.includes(ym)) state = "missing";
        else if (s.expected_months.includes(ym) && s.next_due.slice(0, 7) !== ym && ym < today.slice(0, 7))
          state = "skipped";
        else state = "upcoming";
      }
      return {
        series_key: s.key,
        label: s.label,
        category_id: s.category_id,
        category: s.category,
        vendor: s.vendor,
        subcategory: s.subcategory,
        kind: s.kind,
        cadence_label: s.cadence_label,
        typical_amount: s.typical_amount,
        fixed_amount: s.fixed_amount,
        allocation: s.allocation,
        property_id: s.property_id,
        expected_date: dateIn(monthIdx(ym), s.expected_day),
        state,
        amount: h?.amount ?? null,
        ids: h?.ids ?? [],
      };
    })
    .filter((x) => x !== null)
    .sort((a, b) => a.expected_date.localeCompare(b.expected_date) || a.label.localeCompare(b.label));
  return { month: ym, items, alerts: alerts.filter((a) => a.month === ym) };
}

// ---------- feedback ----------

export const dismissInput = z.object({
  series_key: z.string().regex(/^\d+:\d+:/, "Invalid series key"),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullable()
    .default(null)
    .describe("YYYY-MM to dismiss one month; omit/null to stop tracking the whole series"),
  note: z.string().max(500).default(""),
});

export function dismiss(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const d = dismissInput.parse(raw);
  const month = d.month ?? "";
  const existing = db
    .select({ id: recurringDismissals.id })
    .from(recurringDismissals)
    .where(and(eq(recurringDismissals.seriesKey, d.series_key), eq(recurringDismissals.month, month)))
    .get();
  if (existing) return { id: existing.id };
  const { id } = db
    .insert(recurringDismissals)
    .values({ seriesKey: d.series_key, month, note: d.note, createdBy: actor.user.id })
    .returning({ id: recurringDismissals.id })
    .get();
  audit(db, actor, "create", "recurring_dismissal", id, d);
  return { id };
}

export function undismiss(db: DB, actor: Actor, id: number) {
  requireWrite(actor);
  const row = db.select().from(recurringDismissals).where(eq(recurringDismissals.id, id)).get();
  if (!row) throw notFound("Dismissal");
  db.delete(recurringDismissals).where(eq(recurringDismissals.id, id)).run();
  audit(db, actor, "delete", "recurring_dismissal", id, { series_key: row.seriesKey, month: row.month || null });
  return { ok: true };
}

export function assertMonth(ym: string | undefined) {
  if (!ym || !/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw badRequest("Use month=YYYY-MM");
  return ym;
}
