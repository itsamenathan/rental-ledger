/**
 * Personal-use stays by date (owner, family, below-market rent) and the occupancy numbers derived from them.
 *
 * Nights rule: a stay covers every night from its start date up to, not including, its end date (the checkout
 * day), and each night belongs to the month and year of its own date. Dec 30 → Jan 2 is 2 nights in December and
 * 1 in January.
 *
 * Derived, not written through: for a (property, month) with at least one stay night, owner_nights is the stays'
 * nights in that month and the stored occupancy.owner_nights is ignored. Months without a stay keep the number typed
 * on the Occupancy page (or imported from Grist), and it comes back if the last stay in a month is deleted.
 * `occupancyRows` is the one place that combines the two; every report reads occupancy through it.
 */
import { and, asc, eq, gt, inArray, like, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { occupancy, ownerStays, properties } from "../db/schema.ts";
import { audit, badRequest, diff, notFound, requireWrite, type Actor } from "../context.ts";
import { addDays, listEvents, nightsBetween } from "./calendar.ts";
import { resolvePropertyId } from "./ledger.ts";

export const OWNER_STAY_KINDS = ["owner", "family", "below_market"] as const;
export type OwnerStayKind = (typeof OWNER_STAY_KINDS)[number];
export const KIND_LABEL: Record<OwnerStayKind, string> = {
  owner: "Owner",
  family: "Family",
  below_market: "Below-market",
};

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && addDays(d, 0) === d, "Not a real date");

const kindField = z
  .enum(OWNER_STAY_KINDS)
  .nullable()
  .optional()
  .describe("owner | family | below_market (all count as personal days)");

export const ownerStayInput = z.object({
  property: z.union([z.number().int(), z.string()]).optional(),
  property_id: z.number().int().optional(),
  start_date: isoDate.describe("First night, YYYY-MM-DD"),
  end_date: isoDate.describe("Checkout day, YYYY-MM-DD (not counted): Mar 3 → Mar 6 is 3 nights"),
  kind: kindField,
  note: z.string().max(2000).optional(),
});

export const ownerStayPatch = z.object({
  start_date: isoDate.optional(),
  end_date: isoDate.optional(),
  kind: kindField,
  note: z.string().max(2000).optional(),
});

/** Nights of [start, end) per month (YYYY-MM). */
export function nightsByMonth(start: string, end: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let d = start; d < end;) {
    const month = d.slice(0, 7);
    const next = nextMonthStart(month);
    const stop = end < next ? end : next;
    out.set(month, (out.get(month) ?? 0) + nightsBetween(d, stop));
    d = stop;
  }
  return out;
}

/** Nights of [start, end) that fall in `year`. */
export function nightsInYear(start: string, end: string, year: number) {
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const a = start > from ? start : from;
  const b = end < to ? end : to;
  return b > a ? nightsBetween(a, b) : 0;
}

function nextMonthStart(month: string) {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
}

export interface OwnerStay {
  id: number;
  property_id: number;
  property: string;
  start_date: string;
  end_date: string;
  nights: number;
  kind: OwnerStayKind | null;
  note: string;
  created_at: string;
  updated_at: string;
}

const cols = {
  id: ownerStays.id,
  property_id: ownerStays.propertyId,
  property: properties.name,
  start_date: ownerStays.startDate,
  end_date: ownerStays.endDate,
  kind: ownerStays.kind,
  note: ownerStays.note,
  created_at: ownerStays.createdAt,
  updated_at: ownerStays.updatedAt,
};

function selectStays(db: DB) {
  return db.select(cols).from(ownerStays).innerJoin(properties, eq(properties.id, ownerStays.propertyId));
}

const withNights = <T extends { start_date: string; end_date: string }>(r: T) => ({
  ...r,
  nights: nightsBetween(r.start_date, r.end_date),
});

/** Stays with at least one night in [from, to). */
function staysBetween(db: DB, opts: { from?: string; to?: string; property_id?: number }) {
  return selectStays(db)
    .where(
      and(
        opts.to ? lt(ownerStays.startDate, opts.to) : undefined,
        opts.from ? gt(ownerStays.endDate, opts.from) : undefined,
        opts.property_id ? eq(ownerStays.propertyId, opts.property_id) : undefined,
      ),
    )
    .orderBy(asc(ownerStays.startDate), asc(ownerStays.id))
    .all()
    .map(withNights);
}

/** Stays with a night in `year` (or all), each with its nights in that year. property_id undefined = every one. */
export function listOwnerStays(db: DB, opts: { year?: number; property_id?: number } = {}) {
  const range = opts.year ? { from: `${opts.year}-01-01`, to: `${opts.year + 1}-01-01` } : {};
  return staysBetween(db, { ...range, property_id: opts.property_id }).map((s) => ({
    ...s,
    nights_in_year: opts.year ? nightsInYear(s.start_date, s.end_date, opts.year) : s.nights,
  }));
}

export function getOwnerStay(db: DB, id: number): OwnerStay {
  const r = selectStays(db).where(eq(ownerStays.id, id)).get();
  if (!r) throw notFound("Owner stay");
  return withNights(r);
}

const shortDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function validate(db: DB, propertyId: number, start: string, end: string, exceptId?: number) {
  if (end <= start) throw badRequest("The checkout day must be after the first night");
  if (nightsBetween(start, end) > 366) throw badRequest("A stay can be at most 366 nights");
  const clash = selectStays(db)
    .where(
      and(
        eq(ownerStays.propertyId, propertyId),
        lt(ownerStays.startDate, end),
        gt(ownerStays.endDate, start),
        exceptId ? ne(ownerStays.id, exceptId) : undefined,
      ),
    )
    .get();
  if (clash)
    throw badRequest(
      `Overlaps the stay ${shortDate(clash.start_date)} – ${shortDate(clash.end_date)}. Edit that one instead.`,
      { overlaps: withNights(clash) },
    );
}

/** Guest reservations on the calendar that share a night with [start, end): worth a warning, not an error. */
function guestOverlapWarnings(db: DB, propertyId: number, start: string, end: string) {
  return listEvents(db, { from: start, to: end, property_id: propertyId })
    .filter((e) => e.kind === "reserved")
    .map((e) => {
      const a = e.start_date > start ? e.start_date : start;
      const b = e.end_date < end ? e.end_date : end;
      return `${nightsBetween(a, b)} night(s) overlap a guest stay on the calendar (${e.feed}: ${shortDate(e.start_date)} – ${shortDate(e.end_date)}, ${e.summary}).`;
    });
}

export function addOwnerStay(db: DB, actor: Actor | null, raw: unknown) {
  if (actor) requireWrite(actor);
  const i = ownerStayInput.parse(raw);
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  return tx(db, () => {
    validate(db, propertyId, i.start_date, i.end_date);
    const row = db
      .insert(ownerStays)
      .values({
        propertyId,
        startDate: i.start_date,
        endDate: i.end_date,
        kind: i.kind ?? null,
        note: i.note ?? "",
        createdBy: actor?.user.id ?? null,
      })
      .returning({ id: ownerStays.id })
      .get();
    const stay = getOwnerStay(db, row.id);
    audit(db, actor, "create", "owner_stay", stay.id, stay);
    return { stay, warnings: guestOverlapWarnings(db, propertyId, stay.start_date, stay.end_date) };
  });
}

export function updateOwnerStay(db: DB, actor: Actor, id: number, raw: unknown) {
  requireWrite(actor);
  const p = ownerStayPatch.parse(raw);
  return tx(db, () => {
    const before = getOwnerStay(db, id);
    const start = p.start_date ?? before.start_date;
    const end = p.end_date ?? before.end_date;
    validate(db, before.property_id, start, end, id);
    db.update(ownerStays)
      .set({
        startDate: start,
        endDate: end,
        kind: p.kind !== undefined ? p.kind : before.kind,
        note: p.note ?? before.note,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(ownerStays.id, id))
      .run();
    const stay = getOwnerStay(db, id);
    const { updated_at: _a, ...b } = before;
    const { updated_at: _b, ...a } = stay;
    audit(db, actor, "update", "owner_stay", id, diff(b, a));
    return { stay, warnings: guestOverlapWarnings(db, stay.property_id, stay.start_date, stay.end_date) };
  });
}

export function deleteOwnerStay(db: DB, actor: Actor, id: number) {
  requireWrite(actor);
  return tx(db, () => {
    const before = getOwnerStay(db, id);
    db.delete(ownerStays).where(eq(ownerStays.id, id)).run();
    audit(db, actor, "delete", "owner_stay", id, before);
    return before;
  });
}

// ======================= derived occupancy =======================

const key = (propertyId: number, month: string) => `${propertyId}|${month}`;

/** Stay nights per (property, month) for months in [fromMonth, toMonth]; a missing bound is open. */
export function stayNightsByMonth(db: DB, opts: { fromMonth?: string; toMonth?: string; propertyId?: number }) {
  const out = new Map<string, number>();
  const stays = staysBetween(db, {
    from: opts.fromMonth ? `${opts.fromMonth}-01` : undefined,
    to: opts.toMonth ? nextMonthStart(opts.toMonth) : undefined,
    property_id: opts.propertyId,
  });
  for (const s of stays)
    for (const [month, n] of nightsByMonth(s.start_date, s.end_date))
      if ((!opts.fromMonth || month >= opts.fromMonth) && (!opts.toMonth || month <= opts.toMonth))
        out.set(key(s.property_id, month), (out.get(key(s.property_id, month)) ?? 0) + n);
  return out;
}

/** True when the property has a stay with a night in `month`: its owner_nights then come from the stays. */
export function monthHasStays(db: DB, propertyId: number, month: string) {
  return stayNightsByMonth(db, { fromMonth: month, toMonth: month, propertyId }).size > 0;
}

export interface OccupancyRow {
  /** null for a month that has owner stays but no saved occupancy row */
  id: number | null;
  property_id: number;
  property: string;
  month: string;
  nights_available: number | null;
  nights_booked: number;
  /** Personal-use nights: from the owner stays when the month has any, else the number typed in */
  owner_nights: number;
  check_ins: number;
  notes: string;
  owner_nights_source: "stays" | "manual";
  /** The stored (typed or imported) owner nights, ignored while the month has stays; null without a saved row */
  manual_owner_nights: number | null;
  /** false when only owner stays put the month here (no guest nights recorded) */
  recorded: boolean;
}

/**
 * Occupancy per (property, month) as every report should see it: the saved rows with owner_nights replaced by the
 * stays' nights where a month has any, plus a row for each month that has stays but nothing saved. `year` or
 * `month` narrows it; propertyId undefined = every property (each property's months decided on their own).
 */
export function occupancyRows(db: DB, opts: { year?: number; month?: string; propertyId?: number } = {}) {
  const o = occupancy;
  const prefix = opts.month ?? (opts.year ? `${opts.year}-` : undefined);
  const stored = db
    .select({
      id: o.id,
      property_id: o.propertyId,
      property: properties.name,
      month: o.month,
      nights_available: o.nightsAvailable,
      nights_booked: o.nightsBooked,
      owner_nights: o.ownerNights,
      check_ins: o.checkIns,
      notes: o.notes,
    })
    .from(o)
    .innerJoin(properties, eq(properties.id, o.propertyId))
    .where(
      and(
        prefix ? like(o.month, opts.month ? prefix : `${prefix}%`) : undefined,
        opts.propertyId ? eq(o.propertyId, opts.propertyId) : undefined,
      ),
    )
    .all();
  // no year or month: every stay (open bounds; a "9999-12" sentinel would compare wrong as text)
  const fromMonth = opts.month ?? (opts.year ? `${opts.year}-01` : undefined);
  const toMonth = opts.month ?? (opts.year ? `${opts.year}-12` : undefined);
  const stayNights = stayNightsByMonth(db, { fromMonth, toMonth, propertyId: opts.propertyId });

  const rows: OccupancyRow[] = stored.map((r) => {
    const fromStays = stayNights.get(key(r.property_id, r.month));
    return {
      ...r,
      owner_nights: fromStays ?? r.owner_nights,
      owner_nights_source: fromStays != null ? "stays" : "manual",
      manual_owner_nights: r.owner_nights,
      recorded: true,
    };
  });
  const have = new Set(rows.map((r) => key(r.property_id, r.month)));
  const missing = [...stayNights.keys()].filter((k) => !have.has(k));
  if (missing.length) {
    const ids = [...new Set(missing.map((k) => Number(k.split("|")[0])))];
    const names = new Map(
      db
        .select({ id: properties.id, name: properties.name })
        .from(properties)
        .where(inArray(properties.id, ids))
        .all()
        .map((p) => [p.id, p.name]),
    );
    for (const k of missing) {
      const [pid, month] = k.split("|") as [string, string];
      rows.push({
        id: null,
        property_id: Number(pid),
        property: names.get(Number(pid)) ?? "",
        month,
        nights_available: null,
        nights_booked: 0,
        owner_nights: stayNights.get(k)!,
        check_ins: 0,
        notes: "",
        owner_nights_source: "stays",
        manual_owner_nights: null,
        recorded: false,
      });
    }
  }
  return rows.sort((a, b) => b.month.localeCompare(a.month) || a.property_id - b.property_id);
}

/** Personal-use ranges in `year`, e.g. "Mar 5-8, Dec 30-Jan 2" (first night to checkout day), and their nights. */
export function personalUseRanges(stays: { start_date: string; end_date: string; nights_in_year: number }[]) {
  const fmt = (s: { start_date: string; end_date: string }) => {
    const a = shortDate(s.start_date);
    const b = shortDate(s.end_date);
    return s.start_date.slice(0, 7) === s.end_date.slice(0, 7) ? `${a}-${b.split(" ")[1]}` : `${a}-${b}`;
  };
  return {
    text: stays.map(fmt).join(", "),
    nights: stays.reduce((a, s) => a + s.nights_in_year, 0),
  };
}
