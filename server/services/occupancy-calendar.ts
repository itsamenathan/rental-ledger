/**
 * The booking calendar as an input to occupancy, never a source that writes on its own:
 * - guest nights: compare each ended month's calendar nights and check-ins (calendarMonths: feed > history >
 *   statement, cancelled stays already gone) with the saved occupancy row, and copy them over only when asked;
 * - owner stays to confirm: blocked ranges with no reservation from any source, ranked by how likely they are an
 *   owner stay. Nothing counts until the user confirms one (it becomes an owner stay) or dismisses it.
 */
import { and, asc, eq, min } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { calendarEvents, calendarFeeds, occupancy, ownerStayDismissals, properties } from "../db/schema.ts";
import { audit, badRequest, notFound, requireWrite, type Actor } from "../context.ts";
import { addDays, calendarMonths, nightsBetween, type CalendarEvent } from "./calendar.ts";
import { resolvePropertyId } from "./ledger.ts";
import { listOwnerStays, nightsInYear } from "./owner-stays.ts";
import { upsertOccupancy } from "./rental.ts";

const isoToday = () => new Date().toISOString().slice(0, 10);
const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;
const nextMonthOf = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y! + 1}-01` : `${y}-${String(mo! + 1).padStart(2, "0")}`;
};
const yearMonths = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

// ======================= guest nights =======================

export type CompareStatus = "not_ended" | "no_data" | "match" | "differs";

export interface MonthCompare {
  month: string;
  status: CompareStatus;
  /** null when the month hasn't ended or the calendar has no reservation in it ("no data", not zero) */
  calendar: { nights_booked: number; check_ins: number } | null;
  /** the saved occupancy row's numbers; null when nothing is saved for the month */
  stored: { nights_booked: number; check_ins: number } | null;
  /** calendar nights below the saved number: may be a booking the calendar doesn't know (direct, off-platform) */
  calendar_lower: boolean;
  /**
   * Connected feeds whose data starts after the month began (Airbnb exports only ~60 days of past stays, or the
   * feed is new), when no imported reservation history covers the month: that platform's stays may be missing.
   */
  incomplete: string[];
}

/** Each feed of the property with the start of its earliest event (null when it has none). */
function feedCoverage(db: DB, propertyId: number) {
  return db
    .select({ id: calendarFeeds.id, name: calendarFeeds.name, first: min(calendarEvents.startDate) })
    .from(calendarFeeds)
    .leftJoin(calendarEvents, eq(calendarEvents.feedId, calendarFeeds.id))
    .where(eq(calendarFeeds.propertyId, propertyId))
    .groupBy(calendarFeeds.id)
    .orderBy(asc(calendarFeeds.id))
    .all();
}

/** Calendar vs saved guest nights for each month of `year`, for one property. */
export function compareOccupancyCalendar(
  db: DB,
  raw: { property_id?: number | string; year: number; today?: string },
): { property_id: number; year: number; months: MonthCompare[]; differing: string[] } {
  const propertyId = resolvePropertyId(db, raw.property_id);
  const year = raw.year;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest("Pass a year");
  const thisMonth = (raw.today ?? isoToday()).slice(0, 7);
  const { months: cal, loaded } = calendarMonths(db, propertyId, `${year}-01`, `${year}-12`);
  const feeds = feedCoverage(db, propertyId);
  const history = loaded.filter((e) => e.source === "history");
  const saved = db
    .select({ month: occupancy.month, nights_booked: occupancy.nightsBooked, check_ins: occupancy.checkIns })
    .from(occupancy)
    .where(eq(occupancy.propertyId, propertyId))
    .all();
  const months = yearMonths(year).map((month): MonthCompare => {
    const c = cal.find((m) => m.month === month)!;
    const s = saved.find((r) => r.month === month);
    const stored = s ? { nights_booked: s.nights_booked, check_ins: s.check_ins } : null;
    const monthEnd = `${nextMonthOf(month)}-01`;
    const hasHistory = history.some((e) => e.start_date < monthEnd && e.end_date > `${month}-01`);
    const incomplete = hasHistory
      ? []
      : feeds.filter((f) => f.first == null || f.first > `${month}-01`).map((f) => f.name);
    const base = { month, stored, calendar: null, calendar_lower: false, incomplete };
    if (month >= thisMonth) return { ...base, status: "not_ended" };
    if (c.booked_nights === 0) return { ...base, status: "no_data" };
    const calendar = { nights_booked: c.booked_nights, check_ins: c.check_ins };
    const same = stored && stored.nights_booked === calendar.nights_booked && stored.check_ins === calendar.check_ins;
    return {
      ...base,
      calendar,
      status: same ? "match" : "differs",
      calendar_lower: !!stored && calendar.nights_booked < stored.nights_booked,
    };
  });
  return {
    property_id: propertyId,
    year,
    months,
    differing: months.filter((m) => m.status === "differs").map((m) => m.month),
  };
}

export const applyInput = z.object({
  property: z.union([z.number().int(), z.string()]).optional(),
  property_id: z.number().int().optional(),
  months: z.array(z.string().regex(monthRe, "Use YYYY-MM")).min(1).max(36),
  confirm_lower: z
    .boolean()
    .default(false)
    .describe("Also apply months where the calendar has fewer nights than saved (the user confirmed each one)"),
});

/**
 * Copy the calendar's guest nights and check-ins into the saved occupancy of the given months, through
 * upsertOccupancy so it is audited. Owner nights, available nights and notes are kept as saved. Months that haven't
 * ended or have no calendar reservations are skipped, and so are months where the calendar is lower unless
 * confirm_lower (a direct booking the calendar doesn't know would otherwise be lost).
 */
export function applyCalendarToOccupancy(db: DB, actor: Actor | null, raw: unknown, today = isoToday()) {
  if (actor) requireWrite(actor);
  const i = applyInput.parse(raw);
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  const applied: { month: string; nights_booked: [number | null, number]; check_ins: [number | null, number] }[] = [];
  const skipped: { month: string; reason: string }[] = [];
  const byYear = new Map<number, MonthCompare[]>();
  const compareFor = (month: string) => {
    const y = Number(month.slice(0, 4));
    if (!byYear.has(y)) byYear.set(y, compareOccupancyCalendar(db, { property_id: propertyId, year: y, today }).months);
    return byYear.get(y)!.find((m) => m.month === month)!;
  };
  tx(db, () => {
    for (const month of [...new Set(i.months)].sort()) {
      const c = compareFor(month);
      if (c.status === "not_ended") skipped.push({ month, reason: "The month hasn't ended yet" });
      else if (c.status === "no_data") skipped.push({ month, reason: "The calendar has no reservations this month" });
      else if (c.status === "match") skipped.push({ month, reason: "Already the same" });
      else if (c.calendar_lower && !i.confirm_lower)
        skipped.push({
          month,
          reason: `The calendar has fewer nights (${c.calendar!.nights_booked}) than saved (${c.stored!.nights_booked}); confirm to use it`,
        });
      else {
        const cur = db
          .select()
          .from(occupancy)
          .where(and(eq(occupancy.propertyId, propertyId), eq(occupancy.month, month)))
          .get();
        upsertOccupancy(db, actor, {
          property_id: propertyId,
          month,
          nights_available: cur?.nightsAvailable ?? null,
          nights_booked: c.calendar!.nights_booked,
          check_ins: c.calendar!.check_ins,
          // the stored number, not the derived one: upsertOccupancy keeps it anyway while the month has stays
          owner_nights: cur?.ownerNights ?? 0,
          notes: cur?.notes ?? "",
        });
        applied.push({
          month,
          nights_booked: [c.stored?.nights_booked ?? null, c.calendar!.nights_booked],
          check_ins: [c.stored?.check_ins ?? null, c.calendar!.check_ins],
        });
      }
    }
  });
  return { property_id: propertyId, applied, skipped };
}

// ======================= owner stays to confirm =======================

export type Signal = "strong" | "unclear" | "weak";

export interface StayCandidate {
  start_date: string;
  end_date: string;
  nights: number;
  nights_in_year: number;
  /** feeds whose blocks cover every night of the range */
  blocked_on: string[];
  /** feeds whose data reaches back to the range (only they can say whether the dates were free) */
  covering: string[];
  signal: Signal;
  reason: string;
}

const listFormat = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/**
 * Rank one blocked range. With calendars synced between platforms, an owner stay booked through a channel manager
 * is blocked on every platform, while another platform's guest is a reservation on that platform's own feed (so it
 * never gets here when that feed is connected). Only feeds that reach back to the range can vote: Airbnb exports
 * only ~60 days of past events, so an older range seen only on VRBO can't be told apart from an Airbnb guest.
 */
export function rankBlock(c: {
  nights: number;
  blocked_on: string[];
  covering: string[];
  /** a reservation checks out on the first night or checks in on the checkout day */
  next_to_guest: boolean;
}): { signal: Signal; reason: string } {
  if (c.nights === 1 && c.next_to_guest)
    return { signal: "weak", reason: "One night next to a guest stay, often a turnover or prep-time block" };
  if (c.nights > 31) return { signal: "weak", reason: "A long block, often dates closed to bookings" };
  const notBlocking = c.covering.filter((f) => !c.blocked_on.includes(f));
  if (c.covering.length >= 2 && !notBlocking.length)
    return { signal: "strong", reason: `Blocked on every calendar (${listFormat(c.blocked_on)})` };
  if (notBlocking.length)
    return {
      signal: "weak",
      reason: `Blocked only on ${listFormat(c.blocked_on)}; ${listFormat(notBlocking)} shows it open, so it may be a guest from another platform or a hold`,
    };
  return {
    signal: "unclear",
    reason:
      c.covering.length === 1 && c.blocked_on.length
        ? `Unavailable on ${c.blocked_on[0]}, the only calendar that goes back this far`
        : "Unavailable on the calendar",
  };
}

const RANK: Record<Signal, number> = { strong: 0, unclear: 1, weak: 2 };

/**
 * Blocked ranges in `year` that might be owner stays: nights held by a block with no reservation from any source
 * (feed, history or statement), grouped while consecutive nights share a block event. Ranges that haven't started,
 * overlap an owner stay already entered, or were dismissed are left out. Strongest signal first.
 */
export function ownerStayCandidates(
  db: DB,
  raw: { property_id?: number | string; year: number; today?: string },
): { property_id: number; year: number; candidates: StayCandidate[]; dismissed: Dismissal[] } {
  const propertyId = resolvePropertyId(db, raw.property_id);
  const year = raw.year;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest("Pass a year");
  const today = raw.today ?? isoToday();
  // a month either side so a range crossing New Year is seen whole
  const { loaded, best } = calendarMonths(db, propertyId, `${year - 1}-12`, `${year + 1}-01`);
  const blocks = loaded.filter((e) => e.kind === "blocked");
  const blocksOn = (d: string) => blocks.filter((b) => b.start_date <= d && b.end_date > d);

  // group consecutive block-held nights that share at least one block event
  const ranges: { start: string; end: string; events: Set<CalendarEvent> }[] = [];
  const nights = [...best.entries()].filter(([, ev]) => ev.kind === "blocked").map(([d]) => d);
  nights.sort();
  for (const d of nights) {
    const evs = blocksOn(d);
    const last = ranges.at(-1);
    if (last && last.end === d && evs.some((e) => last.events.has(e))) {
      last.end = addDays(d, 1);
      for (const e of evs) last.events.add(e);
    } else ranges.push({ start: d, end: addDays(d, 1), events: new Set(evs) });
  }

  const feeds = feedCoverage(db, propertyId);
  const stays = listOwnerStays(db, { property_id: propertyId });
  const dismissed = listDismissals(db, propertyId);
  const reservations = loaded.filter((e) => e.kind === "reserved");

  const candidates: StayCandidate[] = [];
  for (const r of ranges) {
    if (r.start > today) continue;
    const inYear = nightsInYear(r.start, r.end, year);
    if (!inYear) continue;
    if (stays.some((s) => s.start_date < r.end && s.end_date > r.start)) continue;
    if (dismissed.some((x) => x.start_date === r.start && x.end_date === r.end)) continue;
    const n = nightsBetween(r.start, r.end);
    const blockedOn = feeds
      .filter((f) => {
        for (let d = r.start; d < r.end; d = addDays(d, 1))
          if (!blocks.some((b) => b.feed_id === f.id && b.start_date <= d && b.end_date > d)) return false;
        return true;
      })
      .map((f) => f.name);
    const covering = feeds.filter((f) => f.first != null && f.first <= r.start).map((f) => f.name);
    const nextToGuest = reservations.some((e) => e.end_date === r.start || e.start_date === r.end);
    candidates.push({
      start_date: r.start,
      end_date: r.end,
      nights: n,
      nights_in_year: inYear,
      blocked_on: blockedOn,
      covering,
      ...rankBlock({ nights: n, blocked_on: blockedOn, covering, next_to_guest: nextToGuest }),
    });
  }
  candidates.sort((a, b) => RANK[a.signal] - RANK[b.signal] || a.start_date.localeCompare(b.start_date));
  return { property_id: propertyId, year, candidates, dismissed };
}

// ---------- "Not a stay" ----------

export interface Dismissal {
  id: number;
  property_id: number;
  start_date: string;
  end_date: string;
  created_at: string;
}

function listDismissals(db: DB, propertyId: number): Dismissal[] {
  const d = ownerStayDismissals;
  return db
    .select({
      id: d.id,
      property_id: d.propertyId,
      start_date: d.startDate,
      end_date: d.endDate,
      created_at: d.createdAt,
    })
    .from(d)
    .where(eq(d.propertyId, propertyId))
    .orderBy(asc(d.startDate))
    .all();
}

export const dismissInput = z.object({
  property: z.union([z.number().int(), z.string()]).optional(),
  property_id: z.number().int().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
});

/** Remember that a blocked range is not an owner stay, so it isn't suggested again. */
export function dismissCandidate(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const i = dismissInput.parse(raw);
  if (i.end_date <= i.start_date) throw badRequest("The end date must be after the start date");
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  return tx(db, () => {
    const row = db
      .insert(ownerStayDismissals)
      .values({ propertyId, startDate: i.start_date, endDate: i.end_date, createdBy: actor.user.id })
      .onConflictDoNothing()
      .returning({ id: ownerStayDismissals.id })
      .get();
    if (row)
      audit(db, actor, "create", "owner_stay_dismissal", row.id, {
        property_id: propertyId,
        start_date: i.start_date,
        end_date: i.end_date,
      });
    return { ok: true, id: row?.id ?? null };
  });
}

/** Suggest a dismissed range again. */
export function undismissCandidate(db: DB, actor: Actor, id: number) {
  requireWrite(actor);
  return tx(db, () => {
    const before = db.select().from(ownerStayDismissals).where(eq(ownerStayDismissals.id, id)).get();
    if (!before) throw notFound("Dismissed range");
    db.delete(ownerStayDismissals).where(eq(ownerStayDismissals.id, id)).run();
    audit(db, actor, "delete", "owner_stay_dismissal", id, {
      property_id: before.propertyId,
      start_date: before.startDate,
      end_date: before.endDate,
    });
    return { ok: true };
  });
}

// ======================= To do =======================

export interface OccupancyAttention {
  property_id: number;
  property: string;
  /** likely owner stays (blocked on every calendar that reaches the dates), this year and last */
  owner_stays: StayCandidate[];
  /** ended months, this year and last, where a calendar that covers the whole month disagrees with the saved nights */
  guest_nights: MonthCompare[];
}

/**
 * What the Occupancy page wants confirmed, for the To do page: only the confident items. Less certain blocks and
 * months a calendar doesn't fully cover stay on the Occupancy page. Last year is included for tax time.
 */
export function occupancyAttention(db: DB, opts: { propertyId?: number; today?: string } = {}): OccupancyAttention[] {
  const today = opts.today ?? isoToday();
  const year = Number(today.slice(0, 4));
  const props = db
    .select({ id: properties.id, name: properties.name })
    .from(properties)
    .where(opts.propertyId ? eq(properties.id, opts.propertyId) : eq(properties.archived, false))
    .orderBy(asc(properties.name))
    .all();
  const out: OccupancyAttention[] = [];
  for (const p of props) {
    const stays = new Map<string, StayCandidate>();
    const months: MonthCompare[] = [];
    for (const y of [year - 1, year]) {
      for (const c of ownerStayCandidates(db, { property_id: p.id, year: y, today }).candidates)
        if (c.signal === "strong") stays.set(`${c.start_date}/${c.end_date}`, c);
      for (const m of compareOccupancyCalendar(db, { property_id: p.id, year: y, today }).months)
        if (m.status === "differs" && !m.incomplete.length) months.push(m);
    }
    if (stays.size || months.length)
      out.push({ property_id: p.id, property: p.name, owner_stays: [...stays.values()], guest_nights: months });
  }
  return out;
}
