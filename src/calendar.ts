import { fmtDate, shiftMonth } from "./format.ts";

/** Booking-calendar feeds (Airbnb/VRBO iCal links) are property settings: managed in Settings → Properties. */
export interface Feed {
  property_id: number;
  id: number;
  name: string;
  url: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  events: number;
}

export interface SyncResult {
  name: string;
  added: number;
  updated: number;
  removed: number;
  error?: string;
}

/** Past stays kept on the calendar besides the feeds (GET calendar/history). */
export interface HistorySummary {
  property_id: number;
  stays: number;
  first: string | null;
  last: string | null;
  statement_stays: number;
}

export interface HistoryImport {
  listings: string[];
  listing: string | null;
  stays: number;
  added: number;
  updated: number;
  unchanged: number;
  on_calendar: number;
  skipped_cancelled: number;
  skipped_upcoming: number;
  skipped_other_listings: number;
  dry_run: boolean;
}

export function ago(iso: string | null) {
  if (!iso) return "never";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return fmtDate(iso.slice(0, 10));
}

export function syncText(r: SyncResult) {
  if (r.error) return `${r.name}: ${r.error}`;
  const parts = [
    r.added && `${r.added} new`,
    r.updated && `${r.updated} changed`,
    r.removed && `${r.removed} cancelled`,
  ].filter(Boolean);
  return `${r.name}: ${parts.length ? parts.join(", ") : "no changes"}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const shiftDay = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** How many days `iso` is past the start of its week (0 = it is the first day). weekStart: 0 = Sunday … 6 = Saturday. */
const daysIntoWeek = (iso: string, weekStart: number) => (new Date(`${iso}T00:00:00Z`).getUTCDay() - weekStart + 7) % 7;

/** Weekday headers in display order for a week that starts on `weekStart`. */
export const weekdayNames = (weekStart: number) => Array.from({ length: 7 }, (_, i) => DAY_NAMES[(weekStart + i) % 7]!);

/**
 * The weeks a month grid shows, one array of seven YYYY-MM-DD days per row: from the first day of the week the 1st
 * falls in to the last day of the week the month's last day falls in.
 */
export function monthWeeks(month: string, weekStart: number): string[][] {
  const first = `${month}-01`;
  const last = shiftDay(`${shiftMonth(month, 1)}-01`, -1);
  const weeks: string[][] = [];
  for (
    let d = shiftDay(first, -daysIntoWeek(first, weekStart));
    d <= shiftDay(last, 6 - daysIntoWeek(last, weekStart));
    d = shiftDay(d, 7)
  )
    weeks.push(Array.from({ length: 7 }, (_, i) => shiftDay(d, i)));
  return weeks;
}
