import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { getDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const cal = await import("./services/calendar.ts");
const { startScheduler } = await import("./scheduler.ts");

describe("background calendar refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("refreshes stale linked feeds on a timer, and is off at 0", async () => {
    const db = getDb();
    seedDefaults(db);
    const feed = cal.createFeed(db, null, { name: "Airbnb", url: "https://www.airbnb.com/calendar/ical/1.ics?s=x" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"));
    vi.useFakeTimers();

    expect(startScheduler(0)).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    const stop = startScheduler(180);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cal.listFeeds(db, null)[0]).toMatchObject({ id: feed.id, last_error: null });
    expect(cal.listFeeds(db, null)[0]!.last_synced_at).toBeTruthy();

    // synced just now, so the next ticks skip it until it's stale again
    await vi.advanceTimersByTimeAsync(90 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(135 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(400 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
