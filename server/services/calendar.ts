/**
 * Booking calendar: a read-only view of when the property is booked, blocked or free, imported from iCal feeds
 * (Airbnb/VRBO "export calendar" links, or uploaded .ics files).
 *
 * Feed events are upserted by UID on every sync. An event that disappears from the feed is deleted only if it
 * hasn't ended yet (a cancellation); past stays are kept because Airbnb drops old events from its export.
 *
 * When events overlap, a reservation beats a block: with calendars synced between platforms, Airbnb shows each
 * VRBO stay as "Not available" and VRBO shows each Airbnb stay as "Blocked".
 */
import { and, asc, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { calendarEvents, calendarFeeds } from "../db/schema.ts";
import { AppError, audit, badRequest, diff, notFound, requireWrite, type Actor } from "../context.ts";
import { log, withSpan } from "../telemetry.ts";
import { resolvePropertyId } from "./ledger.ts";

export type EventKind = "reserved" | "blocked";

// ======================= iCal parsing =======================

export interface IcsEvent {
  uid: string;
  start: string;
  end: string;
  summary: string;
  description: string;
}

const DAY_MS = 86_400_000;
export const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const nightsBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

const unescape = (v: string) => v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

/** DTSTART/DTEND value → YYYY-MM-DD. Date-times keep the date as written (check-in day). */
function icsDate(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Parse the VEVENTs of an iCalendar file. Cancelled events and events without a start date are skipped. */
export function parseIcs(text: string): IcsEvent[] {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw badRequest("That isn't an iCalendar (.ics) file");
  // unfold: a line break followed by a space or tab continues the previous line
  const lines = text
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const events: IcsEvent[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") cur = {};
    else if (upper === "END:VEVENT" && cur) {
      const start = icsDate(cur.DTSTART ?? "");
      let end = cur.DTEND ? icsDate(cur.DTEND) : null;
      if (start && (cur.STATUS ?? "").toUpperCase() !== "CANCELLED") {
        if (!end || end <= start) end = addDays(start, 1);
        const summary = unescape(cur.SUMMARY ?? "").trim();
        events.push({
          uid: (cur.UID ?? "").trim() || `${start}/${end}/${summary}`,
          start,
          end,
          summary,
          description: unescape(cur.DESCRIPTION ?? "").trim(),
        });
      }
      cur = null;
    } else if (cur) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon).split(";")[0]!.trim().toUpperCase();
      // nested components (VALARM) can repeat names; the event's own value comes first
      if (!(name in cur)) cur[name] = line.slice(colon + 1);
    }
  }
  return events;
}

/** Airbnb "Airbnb (Not available)", VRBO "Blocked", Booking.com "CLOSED - Not available" are blocks. */
export function feedKind(summary: string): EventKind {
  return /not available|unavailable|blocked|closed/i.test(summary) ? "blocked" : "reserved";
}

/** "Reserved" plus the Airbnb confirmation code when the description has one. */
function feedSummary(e: IcsEvent) {
  const code = /reservations\/details\/([A-Z0-9]+)/i.exec(e.description)?.[1];
  const base = e.summary || "Reserved";
  return code && !base.includes(code) ? `${base} · ${code}` : base;
}

// ======================= feeds =======================

/** The feed URL is a password: show only the host to read-only users, logs and the audit log. */
export function maskUrl(url: string | null) {
  if (!url) return null;
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return "…";
  }
}

const feedUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u) || /^webcal:\/\//i.test(u), "Use the http(s) or webcal link of the calendar")
  .transform((u) => u.replace(/^webcal:/i, "https:"));

export const feedInput = z.object({
  property: z.union([z.number().int(), z.string()]).optional(),
  property_id: z.number().int().optional(),
  name: z.string().trim().min(1).max(100),
  url: feedUrl.nullable().optional().describe("iCal export link; leave empty to import .ics files by hand"),
});

export interface Feed {
  id: number;
  property_id: number;
  name: string;
  url: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  events: number;
}

function feedRow(db: DB, id: number) {
  const f = db.select().from(calendarFeeds).where(eq(calendarFeeds.id, id)).get();
  if (!f) throw notFound("Calendar");
  return f;
}

export function listFeeds(db: DB, actor: Actor | null, opts: { property_id?: number } = {}): Feed[] {
  const counts = new Map<number, number>();
  for (const b of db.select({ feedId: calendarEvents.feedId }).from(calendarEvents).all())
    if (b.feedId) counts.set(b.feedId, (counts.get(b.feedId) ?? 0) + 1);
  return db
    .select()
    .from(calendarFeeds)
    .where(opts.property_id ? eq(calendarFeeds.propertyId, opts.property_id) : undefined)
    .orderBy(asc(calendarFeeds.id))
    .all()
    .map((f) => ({
      id: f.id,
      property_id: f.propertyId,
      name: f.name,
      url: actor && !actor.canWrite ? maskUrl(f.url) : f.url,
      last_synced_at: f.lastSyncedAt,
      last_error: f.lastError,
      events: counts.get(f.id) ?? 0,
    }));
}

export function createFeed(db: DB, actor: Actor | null, raw: unknown) {
  if (actor) requireWrite(actor);
  const i = feedInput.parse(raw);
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  const row = db
    .insert(calendarFeeds)
    .values({ propertyId, name: i.name, url: i.url || null })
    .returning()
    .get();
  audit(db, actor, "create", "calendar_feed", row.id, { name: i.name, url: maskUrl(row.url) });
  return listFeeds(db, actor).find((f) => f.id === row.id)!;
}

export function updateFeed(db: DB, actor: Actor, id: number, raw: unknown) {
  requireWrite(actor);
  const i = feedInput.pick({ name: true, url: true }).partial().parse(raw);
  const before = feedRow(db, id);
  const set: Partial<typeof calendarFeeds.$inferInsert> = {};
  if (i.name !== undefined) set.name = i.name;
  if (i.url !== undefined) set.url = i.url || null;
  if (set.url !== undefined && set.url !== before.url) set.lastError = null;
  if (!Object.keys(set).length) return listFeeds(db, actor).find((f) => f.id === id)!;
  db.update(calendarFeeds).set(set).where(eq(calendarFeeds.id, id)).run();
  const after = feedRow(db, id);
  audit(
    db,
    actor,
    "update",
    "calendar_feed",
    id,
    diff({ name: before.name, url: maskUrl(before.url) }, { name: after.name, url: maskUrl(after.url) }),
  );
  return listFeeds(db, actor).find((f) => f.id === id)!;
}

/** Removes the feed and every stay imported from it. */
export function deleteFeed(db: DB, actor: Actor, id: number) {
  requireWrite(actor);
  const f = feedRow(db, id);
  tx(db, () => {
    const removed = db.delete(calendarEvents).where(eq(calendarEvents.feedId, id)).run().changes;
    db.delete(calendarFeeds).where(eq(calendarFeeds.id, id)).run();
    audit(db, actor, "delete", "calendar_feed", id, { name: f.name, events: removed });
  });
}

export interface SyncResult {
  feed_id: number;
  name: string;
  events: number;
  added: number;
  updated: number;
  removed: number;
  kept_past: number;
  error?: string;
}

/**
 * Apply a feed's .ics text: upsert events by UID, delete events missing from the feed that haven't ended by
 * `today` (cancelled), keep missing past ones (the platforms drop old stays from their exports).
 */
export function syncFeedText(db: DB, actor: Actor | null, feedId: number, text: string, today = isoToday()) {
  if (actor) requireWrite(actor);
  const feed = feedRow(db, feedId);
  const events = new Map(parseIcs(text).map((e) => [e.uid, e]));
  const result: SyncResult = {
    feed_id: feedId,
    name: feed.name,
    events: events.size,
    added: 0,
    updated: 0,
    removed: 0,
    kept_past: 0,
  };
  tx(db, () => {
    const existing = new Map(
      db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.feedId, feedId))
        .all()
        .map((b) => [b.uid!, b]),
    );
    const stamp = new Date().toISOString();
    for (const e of events.values()) {
      const values = { kind: feedKind(e.summary), startDate: e.start, endDate: e.end, summary: feedSummary(e) };
      const b = existing.get(e.uid);
      if (!b) {
        db.insert(calendarEvents)
          .values({ propertyId: feed.propertyId, feedId, uid: e.uid, ...values })
          .run();
        result.added++;
      } else if (
        b.kind !== values.kind ||
        b.startDate !== values.startDate ||
        b.endDate !== values.endDate ||
        b.summary !== values.summary
      ) {
        db.update(calendarEvents)
          .set({ ...values, updatedAt: stamp })
          .where(eq(calendarEvents.id, b.id))
          .run();
        result.updated++;
      }
    }
    for (const b of existing.values()) {
      if (events.has(b.uid!)) continue;
      if (b.endDate > today) {
        db.delete(calendarEvents).where(eq(calendarEvents.id, b.id)).run();
        result.removed++;
      } else result.kept_past++;
    }
    db.update(calendarFeeds).set({ lastSyncedAt: stamp, lastError: null }).where(eq(calendarFeeds.id, feedId)).run();
    if (result.added || result.updated || result.removed)
      audit(db, actor, "sync", "calendar_feed", feedId, {
        name: feed.name,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
      });
  });
  return result;
}

const MAX_ICS_BYTES = 5_000_000;

async function download(url: string) {
  return withSpan("calendar.fetch", { "url.host": maskUrl(url) ?? "" }, async () => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "text/calendar, */*" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`The calendar link answered ${res.status} ${res.statusText}`.trim());
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_ICS_BYTES) throw new Error("The calendar is too large");
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > MAX_ICS_BYTES) throw new Error("The calendar is too large");
    return new TextDecoder().decode(body);
  });
}

/** Download a feed and sync it. Failures are saved on the feed (shown in the app) and returned, not thrown. */
export async function refreshFeed(db: DB, actor: Actor | null, feedId: number): Promise<SyncResult> {
  if (actor) requireWrite(actor);
  const feed = feedRow(db, feedId);
  const empty = { feed_id: feedId, name: feed.name, events: 0, added: 0, updated: 0, removed: 0, kept_past: 0 };
  if (!feed.url) return { ...empty, error: "This calendar has no link; import an .ics file instead" };
  try {
    const text = await download(feed.url);
    return syncFeedText(db, actor, feedId, text);
  } catch (e) {
    const message =
      e instanceof AppError
        ? e.message
        : (e as Error).name === "TimeoutError"
          ? "The calendar link didn't answer in time"
          : (e as Error).message === "fetch failed"
            ? `Couldn't reach ${maskUrl(feed.url)?.replace(/\/…$/, "")}`
            : (e as Error).message || "Couldn't download the calendar";
    log.warn({ feed_id: feedId, host: maskUrl(feed.url), err: message }, "calendar refresh failed");
    db.update(calendarFeeds)
      .set({ lastError: message, lastSyncedAt: new Date().toISOString() })
      .where(eq(calendarFeeds.id, feedId))
      .run();
    return { ...empty, error: message };
  }
}

/** Refresh every linked feed, or only those not synced in the last `staleMinutes`. */
export async function refreshFeeds(
  db: DB,
  actor: Actor | null,
  opts: { property_id?: number; stale_minutes?: number } = {},
) {
  if (actor) requireWrite(actor);
  const cutoff = opts.stale_minutes ? new Date(Date.now() - opts.stale_minutes * 60_000).toISOString() : null;
  const due = listFeeds(db, actor, opts).filter(
    (f) => f.url && (!cutoff || !f.last_synced_at || f.last_synced_at < cutoff),
  );
  const results: SyncResult[] = [];
  for (const f of due) results.push(await refreshFeed(db, actor, f.id));
  return results;
}

// ======================= calendar view =======================

export interface CalendarEvent {
  id: number;
  property_id: number;
  feed_id: number;
  feed: string;
  kind: EventKind;
  start_date: string;
  end_date: string;
  nights: number;
  summary: string;
}

/** Events that have at least one night in [from, to). */
export function listEvents(db: DB, opts: { from: string; to: string; property_id?: number }): CalendarEvent[] {
  const e = calendarEvents;
  return db
    .select({
      id: e.id,
      property_id: e.propertyId,
      feed_id: e.feedId,
      feed: calendarFeeds.name,
      kind: e.kind,
      start_date: e.startDate,
      end_date: e.endDate,
      summary: e.summary,
    })
    .from(e)
    .innerJoin(calendarFeeds, eq(calendarFeeds.id, e.feedId))
    .where(
      and(
        lt(e.startDate, opts.to),
        gt(e.endDate, opts.from),
        opts.property_id ? eq(e.propertyId, opts.property_id) : undefined,
      ),
    )
    .orderBy(asc(e.startDate), asc(e.id))
    .all()
    .map((r) => ({ ...r, nights: nightsBetween(r.start_date, r.end_date) }));
}

export interface MonthSummary {
  month: string;
  nights: number;
  booked_nights: number;
  blocked_nights: number;
  free_nights: number;
  check_ins: number;
}

const isoToday = () => new Date().toISOString().slice(0, 10);
const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Calendar for whole months [from_month, to_month]: the events, which event holds each night (a reservation
 * beats a block), and per-month booked/blocked/free nights and check-ins.
 */
export function getCalendar(
  db: DB,
  actor: Actor | null,
  opts: { from_month: string; to_month?: string; property_id?: number },
) {
  const toMonth = opts.to_month ?? opts.from_month;
  if (!monthRe.test(opts.from_month) || !monthRe.test(toMonth) || toMonth < opts.from_month)
    throw badRequest("Use months as YYYY-MM");
  const propertyId = resolvePropertyId(db, opts.property_id);
  const from = `${opts.from_month}-01`;
  const to = `${nextMonth(toMonth)}-01`;
  if (nightsBetween(from, to) > 800) throw badRequest("Ask for at most two years at a time");

  const events = listEvents(db, { from, to, property_id: propertyId });
  // start a night early so a stay running into the first month isn't counted as checking in on day one
  const dayBefore = addDays(from, -1);
  const best = new Map<string, CalendarEvent>();
  for (const ev of listEvents(db, { from: dayBefore, to, property_id: propertyId })) {
    for (let d = ev.start_date < dayBefore ? dayBefore : ev.start_date; d < ev.end_date && d < to; d = addDays(d, 1)) {
      const cur = best.get(d);
      if (!cur || (cur.kind === "blocked" && ev.kind === "reserved")) best.set(d, ev);
    }
  }
  const nights: Record<string, number> = {};
  for (const [d, ev] of best) if (d >= from) nights[d] = ev.id;

  const months: MonthSummary[] = [];
  for (let m = opts.from_month; m <= toMonth; m = nextMonth(m)) {
    const s: MonthSummary = { month: m, nights: 0, booked_nights: 0, blocked_nights: 0, free_nights: 0, check_ins: 0 };
    const end = `${nextMonth(m)}-01`;
    for (let d = `${m}-01`; d < end; d = addDays(d, 1)) {
      s.nights++;
      const ev = best.get(d);
      if (!ev) s.free_nights++;
      else if (ev.kind === "blocked") s.blocked_nights++;
      else {
        s.booked_nights++;
        // a check-in is the first night a reservation holds
        if (best.get(addDays(d, -1)) !== ev) s.check_ins++;
      }
    }
    months.push(s);
  }

  return {
    property_id: propertyId,
    from,
    to,
    events,
    nights,
    months,
    feeds: listFeeds(db, actor, { property_id: propertyId }),
  };
}

function nextMonth(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y! + 1}-01` : `${y}-${String(mo! + 1).padStart(2, "0")}`;
}
