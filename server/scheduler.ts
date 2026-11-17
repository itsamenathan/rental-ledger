/**
 * Background jobs for the production server (not `vp dev`, which reloads modules and would leak timers).
 *
 * Calendar refresh: Airbnb drops past stays from its iCal export after a while, so a stay booked and finished while
 * nobody opened the Calendar page would never be recorded. Every `calendarRefreshMinutes` this downloads each
 * linked feed that hasn't synced in that time (a page-load or manual refresh counts).
 */
import { config } from "./config.ts";
import { getDb } from "./db.ts";
import { refreshFeeds } from "./services/calendar.ts";
import { log, withSpan } from "./telemetry.ts";

/** Ticks a little more often than the interval so a sync made by a page load doesn't push the next one a whole interval out. */
const TICK_FRACTION = 4;

export function startScheduler(minutes = config.calendarRefreshMinutes) {
  if (!minutes) {
    log.info("background calendar refresh is off (CALENDAR_REFRESH_MINUTES=0)");
    return () => {};
  }
  let running = false;
  const tick = async () => {
    if (running) return; // a slow download is still going
    running = true;
    try {
      // getDb() on every tick: a backup restore swaps the handle.
      const results = await withSpan("calendar.scheduled_refresh", {}, () =>
        refreshFeeds(getDb(), null, { stale_minutes: minutes }),
      );
      if (results.length)
        log.info(
          {
            feeds: results.length,
            added: results.reduce((n, r) => n + r.added, 0),
            removed: results.reduce((n, r) => n + r.removed, 0),
            failed: results.filter((r) => r.error).length,
          },
          "background calendar refresh",
        );
    } catch (err) {
      log.error({ err }, "background calendar refresh failed");
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 60_000);
  const timer = setInterval(() => void tick(), Math.max(60_000, (minutes * 60_000) / TICK_FRACTION));
  first.unref();
  timer.unref();
  log.info({ every_minutes: minutes }, "background calendar refresh on");
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
