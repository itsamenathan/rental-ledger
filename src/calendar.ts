import { fmtDate } from "./format.ts";

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
