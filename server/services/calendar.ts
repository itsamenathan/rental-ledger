/**
 * Booking calendar: a read-only view of when the property is booked, blocked or free, imported from iCal feeds
 * (Airbnb/VRBO "export calendar" links, or uploaded .ics files).
 *
 * Feed events are upserted by UID on every sync. An event that disappears from the feed is deleted only if it
 * hasn't ended yet (a cancellation); past stays are kept because Airbnb drops old events from its export.
 *
 * Older stays come from two more sources:
 * - history: past stays imported from a reservations export (Airbnb Reservations → Export to CSV), stored with no
 *   feed so syncs never touch them;
 * - statements: every stay on a saved manager statement, derived on each read (nothing stored).
 * A stay from a lower source (feed > history > statement) that overlaps a reservation from a higher one is the
 * same stay and is left out. When events overlap, a reservation beats a block: with calendars synced between
 * platforms, Airbnb shows each VRBO stay as "Not available" and VRBO shows each Airbnb stay as "Blocked".
 */
import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { calendarEvents, calendarFeeds, properties } from "../db/schema.ts";
import { AppError, audit, badRequest, diff, notFound, requireWrite, type Actor } from "../context.ts";
import { log, withSpan } from "../telemetry.ts";
import { parseCsv } from "./csv.ts";
import { resolvePropertyId } from "./ledger.ts";
import { savedStatements, toIsoDate } from "./manager-statement.ts";

export type EventKind = "reserved" | "blocked";
export type EventSource = "feed" | "history" | "statement";

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

// ======================= reservation history (CSV) =======================

export const historyInput = z.object({
  property: z.union([z.number().int(), z.string()]).optional().describe("Property id or name"),
  property_id: z.number().int().optional(),
  csv: z.string().min(1).max(5_000_000).describe("The reservations export as CSV text (Airbnb: Reservations → Export)"),
  listing: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe("Which listing to import when the export has several (its Listing column)"),
  dry_run: z.boolean().default(false).describe("Only report what would be imported"),
});

export interface HistoryImport {
  property_id: number;
  /** Listings in the file (empty when it has no Listing column). */
  listings: string[];
  listing: string | null;
  /** Past stays found for the listing (after skipping the rows below). */
  stays: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Of the stays, how many a linked calendar already shows. They are saved anyway, in case it drops them. */
  on_calendar: number;
  skipped_cancelled: number;
  /** Stays that haven't ended: the linked calendar keeps those up to date. */
  skipped_upcoming: number;
  skipped_other_listings: number;
  dry_run: boolean;
}

/** Statuses of rows that never became a stay. */
const NOT_A_STAY = /cancel|declin|expired|withdrawn|inquiry|request|pending|denied|not accepted/i;

interface HistoryRow {
  code: string;
  start: string;
  end: string;
  guest: string;
  listing: string;
  status: string;
}

/** Columns are matched loosely (Airbnb's export, or any CSV with a code, check-in and checkout per stay). */
export function parseReservationsCsv(text: string): HistoryRow[] {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  const col = {
    code: find(/^(confirmation (code|number)|reservation( id| code| number)?|booking (id|number))$/i),
    start: find(/^(start date|check-?in( date)?|arrival( date)?)$/i),
    end: find(/^(end date|check-?out( date)?|departure( date)?)$/i),
    status: find(/^status$/i),
    guest: find(/^guest( name)?$/i),
    listing: find(/^(listing|listing name|property|property name)$/i),
  };
  const missing = (
    [
      ["Start date (or Check-in)", col.start],
      ["End date (or Checkout)", col.end],
    ] as const
  )
    .filter(([, i]) => i < 0)
    .map(([n]) => n);
  if (missing.length)
    throw badRequest(
      `This doesn't look like a reservations export: missing column(s) ${missing.join(", ")}. ` +
        `Found: ${header.filter(Boolean).join(", ") || "nothing"}`,
    );
  const out: HistoryRow[] = [];
  for (const r of rows.slice(1)) {
    const start = toIsoDate(r[col.start]);
    const end = toIsoDate(r[col.end]);
    if (!start || !end || end <= start) continue;
    const cell = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    out.push({
      code: cell(col.code),
      start,
      end,
      guest: cell(col.guest),
      listing: cell(col.listing),
      status: cell(col.status),
    });
  }
  if (!out.length) throw badRequest("No stays with a start and end date found in the file");
  return out;
}

/**
 * Save the past stays of a reservations export as calendar history, upserted by confirmation code (or the dates
 * when there is none). Cancelled requests and stays that haven't ended are skipped. With several listings in the
 * file, `listing` must say which one is this property.
 */
export function importReservationHistory(db: DB, actor: Actor | null, raw: unknown, today = isoToday()): HistoryImport {
  const i = historyInput.parse(raw);
  if (actor && !i.dry_run) requireWrite(actor);
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  const rows = parseReservationsCsv(i.csv);
  const listings = [...new Set(rows.map((r) => r.listing).filter(Boolean))].sort();
  let listing: string | null = null;
  if (i.listing) {
    listing = listings.find((l) => l.toLowerCase() === i.listing!.toLowerCase()) ?? null;
    if (!listing) throw badRequest(`No listing "${i.listing}" in this file. It has: ${listings.join("; ")}`);
  } else if (listings.length > 1) {
    throw badRequest(
      `This file has ${listings.length} listings. Choose which one is this property: ${listings.join("; ")}`,
      { listings },
    );
  } else listing = listings[0] ?? null;

  const result: HistoryImport = {
    property_id: propertyId,
    listings,
    listing,
    stays: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    on_calendar: 0,
    skipped_cancelled: 0,
    skipped_upcoming: 0,
    skipped_other_listings: 0,
    dry_run: i.dry_run,
  };
  const stays = new Map<string, HistoryRow>();
  for (const r of rows) {
    if (listing && r.listing && r.listing !== listing) result.skipped_other_listings++;
    else if (NOT_A_STAY.test(r.status)) result.skipped_cancelled++;
    else if (r.end > today) result.skipped_upcoming++;
    else stays.set(r.code || `${r.start}/${r.end}`, r);
  }
  result.stays = stays.size;

  const feedStays = storedEvents(db, { from: "0000-01-01", to: "9999-12-31", property_id: propertyId }).filter(
    (e) => e.source === "feed" && e.kind === "reserved",
  );
  tx(db, () => {
    const existing = new Map(
      db
        .select()
        .from(calendarEvents)
        .where(and(eq(calendarEvents.propertyId, propertyId), isNull(calendarEvents.feedId)))
        .all()
        .map((e) => [e.uid, e]),
    );
    const stamp = new Date().toISOString();
    for (const [uid, r] of stays) {
      if (feedStays.some((f) => f.start_date < r.end && f.end_date > r.start)) result.on_calendar++;
      const values = {
        kind: "reserved" as const,
        startDate: r.start,
        endDate: r.end,
        summary: [r.guest || "Reserved", r.code].filter(Boolean).join(" · "),
      };
      const e = existing.get(uid);
      if (!e) {
        if (!i.dry_run)
          db.insert(calendarEvents)
            .values({ propertyId, feedId: null, source: "history", uid, ...values })
            .run();
        result.added++;
      } else if (e.startDate !== values.startDate || e.endDate !== values.endDate || e.summary !== values.summary) {
        if (!i.dry_run)
          db.update(calendarEvents)
            .set({ ...values, updatedAt: stamp })
            .where(eq(calendarEvents.id, e.id))
            .run();
        result.updated++;
      } else result.unchanged++;
    }
    if (!i.dry_run && (result.added || result.updated))
      audit(db, actor, "import", "calendar_history", propertyId, {
        listing,
        added: result.added,
        updated: result.updated,
      });
  });
  return result;
}

export interface HistorySummary {
  property_id: number;
  /** Stays imported from a reservations export. */
  stays: number;
  first: string | null;
  last: string | null;
  /** Stays read from saved manager statements. */
  statement_stays: number;
}

export function getHistory(db: DB, raw: { property_id?: number | string }): HistorySummary {
  const propertyId = resolvePropertyId(db, raw.property_id);
  const rows = db
    .select({ start: calendarEvents.startDate })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.propertyId, propertyId), eq(calendarEvents.source, "history")))
    .orderBy(asc(calendarEvents.startDate))
    .all();
  return {
    property_id: propertyId,
    stays: rows.length,
    first: rows[0]?.start ?? null,
    last: rows.at(-1)?.start ?? null,
    statement_stays: statementStays(db, propertyId).length,
  };
}

/** Remove every stay imported from a reservations export for one property. */
export function clearHistory(db: DB, actor: Actor, raw: { property_id?: number | string }) {
  requireWrite(actor);
  const propertyId = resolvePropertyId(db, raw.property_id);
  return tx(db, () => {
    const removed = db
      .delete(calendarEvents)
      .where(and(eq(calendarEvents.propertyId, propertyId), eq(calendarEvents.source, "history")))
      .run().changes;
    if (removed) audit(db, actor, "delete", "calendar_history", propertyId, { removed });
    return { property_id: propertyId, removed };
  });
}

// ======================= calendar view =======================

export interface CalendarEvent {
  /** Negative for stays read from manager statements (not stored; only stable within one response). */
  id: number;
  property_id: number;
  feed_id: number | null;
  source: EventSource;
  /** Where it came from: the feed's name, "Reservation history" or "Manager statement (Mon YYYY)". */
  feed: string;
  kind: EventKind;
  start_date: string;
  end_date: string;
  nights: number;
  summary: string;
}

/** Stored events (feeds and imported history) that have at least one night in [from, to). */
function storedEvents(db: DB, opts: { from: string; to: string; property_id?: number }): CalendarEvent[] {
  const e = calendarEvents;
  return db
    .select({
      id: e.id,
      property_id: e.propertyId,
      feed_id: e.feedId,
      source: e.source,
      feed: calendarFeeds.name,
      kind: e.kind,
      start_date: e.startDate,
      end_date: e.endDate,
      summary: e.summary,
    })
    .from(e)
    .leftJoin(calendarFeeds, eq(calendarFeeds.id, e.feedId))
    .where(
      and(
        lt(e.startDate, opts.to),
        gt(e.endDate, opts.from),
        opts.property_id ? eq(e.propertyId, opts.property_id) : undefined,
      ),
    )
    .orderBy(asc(e.startDate), asc(e.id))
    .all()
    .map((r) => ({ ...r, feed: r.feed ?? "Reservation history", nights: nightsBetween(r.start_date, r.end_date) }));
}

const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** Every stay on the property's saved manager statements, once per reservation id (the latest statement wins). */
function statementStays(db: DB, propertyId: number): Omit<CalendarEvent, "id">[] {
  const byId = new Map<string, Omit<CalendarEvent, "id">>();
  for (const { month, statement } of savedStatements(db, propertyId))
    for (const r of statement.reservations) {
      if (r.cancelled || r.check_out <= r.check_in) continue;
      byId.set(r.reservation_id, {
        property_id: propertyId,
        feed_id: null,
        source: "statement",
        feed: `Manager statement (${monthName(month)})`,
        kind: "reserved",
        start_date: r.check_in,
        end_date: r.check_out,
        nights: nightsBetween(r.check_in, r.check_out),
        summary: `${r.channel || "Stay"} · #${r.reservation_id}`,
      });
    }
  return [...byId.values()];
}

const RANK: Record<EventSource, number> = { feed: 0, history: 1, statement: 2 };

/**
 * Events with at least one night in [from, to): stored ones plus stays from saved manager statements. A
 * reservation overlapping a reservation from a higher source (feed > history > statement) is the same stay seen
 * twice and is left out; checkout and the next check-in on the same day don't overlap.
 */
export function listEvents(db: DB, opts: { from: string; to: string; property_id?: number }): CalendarEvent[] {
  const all = storedEvents(db, opts);
  const propertyIds = opts.property_id
    ? [opts.property_id]
    : db
        .select({ id: properties.id })
        .from(properties)
        .all()
        .map((p) => p.id);
  let next = -1;
  for (const id of propertyIds)
    for (const s of statementStays(db, id))
      if (s.start_date < opts.to && s.end_date > opts.from) all.push({ ...s, id: next-- });

  const kept: CalendarEvent[] = [];
  for (const e of [...all].sort((a, b) => RANK[a.source] - RANK[b.source])) {
    const dup =
      e.kind === "reserved" &&
      e.source !== "feed" &&
      kept.some(
        (k) =>
          k.kind === "reserved" &&
          k.property_id === e.property_id &&
          RANK[k.source] < RANK[e.source] &&
          k.start_date < e.end_date &&
          k.end_date > e.start_date,
      );
    if (!dup) kept.push(e);
  }
  return kept.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id);
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

  // start a night early so a stay running into the first month isn't counted as checking in on day one
  const dayBefore = addDays(from, -1);
  const loaded = listEvents(db, { from: dayBefore, to, property_id: propertyId });
  const events = loaded.filter((e) => e.end_date > from);
  const best = new Map<string, CalendarEvent>();
  for (const ev of loaded) {
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
    history: getHistory(db, { property_id: propertyId }),
  };
}

function nextMonth(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y! + 1}-01` : `${y}-${String(mo! + 1).padStart(2, "0")}`;
}
