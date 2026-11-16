import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { users, auditLog } = await import("./db/schema.ts");
const cal = await import("./services/calendar.ts");

function setup() {
  const db = openDb(":memory:");
  seedDefaults(db);
  const user = db.insert(users).values({ email: "t@example.com", role: "admin" }).returning().get();
  const actor = { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  const viewer = { ...actor, canWrite: false };
  return { db, actor, viewer };
}

const event = (uid: string, start: string, end: string | null, summary: string, extra = "") =>
  [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART;VALUE=DATE:${start.replace(/-/g, "")}`,
    ...(end ? [`DTEND;VALUE=DATE:${end.replace(/-/g, "")}`] : []),
    `SUMMARY:${summary}`,
    ...(extra ? [extra] : []),
    "END:VEVENT",
  ].join("\r\n");
const ics = (...events: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN", ...events, "END:VCALENDAR"].join(
    "\r\n",
  );

describe("parseIcs", () => {
  it("reads Airbnb date events, folded lines and escapes", () => {
    const text = ics(
      event(
        "a1@airbnb.com",
        "2026-11-20",
        "2026-11-23",
        "Reserved",
        "DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de\r\n tails/HMABC123\\nPhone Number (Last 4 Digits): 1234",
      ),
      event("a2@airbnb.com", "2026-12-01", "2026-12-04", "Airbnb (Not available)"),
    );
    const evs = cal.parseIcs(text);
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ uid: "a1@airbnb.com", start: "2026-11-20", end: "2026-11-23", summary: "Reserved" });
    expect(evs[0]!.description).toContain("details/HMABC123\nPhone");
    expect(cal.feedKind(evs[0]!.summary)).toBe("reserved");
    expect(cal.feedKind(evs[1]!.summary)).toBe("blocked");
  });

  it("handles date-times, VRBO summaries, a missing DTEND and cancelled events", () => {
    const text = ics(
      [
        "BEGIN:VEVENT",
        "UID:v1",
        "DTSTART:20261105T160000Z",
        "DTEND:20261108T100000Z",
        "SUMMARY:Reserved - Jane D\\, party of 4",
        "END:VEVENT",
      ].join("\n"),
      event("v2", "2026-11-10", null, "Blocked"),
      ["BEGIN:VEVENT", "UID:v3", "DTSTART;VALUE=DATE:20261112", "STATUS:CANCELLED", "END:VEVENT"].join("\n"),
    );
    const evs = cal.parseIcs(text);
    expect(evs.map((e) => [e.uid, e.start, e.end])).toEqual([
      ["v1", "2026-11-05", "2026-11-08"],
      ["v2", "2026-11-10", "2026-11-11"],
    ]);
    expect(evs[0]!.summary).toBe("Reserved - Jane D, party of 4");
    expect(cal.feedKind("Blocked")).toBe("blocked");
  });

  it("rejects something that isn't a calendar", () => {
    expect(() => cal.parseIcs("<html>login</html>")).toThrow(/iCalendar/);
  });
});

describe("feed sync", () => {
  it("adds, updates, cancels future stays and keeps past ones that drop off the feed", () => {
    const { db, actor } = setup();
    const feed = cal.createFeed(db, actor, {
      name: "Airbnb",
      url: "https://www.airbnb.com/calendar/ical/1.ics?s=secret",
    });
    const first = cal.syncFeedText(
      db,
      actor,
      feed.id,
      ics(
        event("past", "2026-09-01", "2026-09-04", "Reserved"),
        event("soon", "2026-11-20", "2026-11-23", "Reserved"),
        event("later", "2026-12-10", "2026-12-12", "Reserved"),
      ),
      "2026-11-16",
    );
    expect(first).toMatchObject({ added: 3, updated: 0, removed: 0 });

    // "past" aged out of the export, "soon" moved a day, "later" was cancelled
    const second = cal.syncFeedText(
      db,
      actor,
      feed.id,
      ics(event("soon", "2026-11-21", "2026-11-23", "Reserved")),
      "2026-11-16",
    );
    expect(second).toMatchObject({ added: 0, updated: 1, removed: 1, kept_past: 1 });
    const left = cal.listEvents(db, { from: "2026-01-01", to: "2027-01-01" });
    expect(left.map((b) => [b.start_date, b.end_date])).toEqual([
      ["2026-09-01", "2026-09-04"],
      ["2026-11-21", "2026-11-23"],
    ]);

    // unchanged sync writes no audit entry
    const audits = () =>
      db
        .select()
        .from(auditLog)
        .all()
        .filter((r) => r.action === "sync").length;
    const before = audits();
    cal.syncFeedText(db, actor, feed.id, ics(event("soon", "2026-11-21", "2026-11-23", "Reserved")), "2026-11-16");
    expect(audits()).toBe(before);
  });

  it("keeps the secret link out of the audit log and away from read-only users", () => {
    const { db, actor, viewer } = setup();
    cal.createFeed(db, actor, { name: "VRBO", url: "webcal://www.vrbo.com/icalendar/abcdef-secret.ics" });
    expect(cal.listFeeds(db, actor)[0]!.url).toBe("https://www.vrbo.com/icalendar/abcdef-secret.ics");
    expect(cal.listFeeds(db, viewer)[0]!.url).toBe("https://www.vrbo.com/…");
    const logged = JSON.stringify(db.select().from(auditLog).all());
    expect(logged).not.toContain("secret");
    expect(() => cal.createFeed(db, actor, { name: "x", url: "file:///etc/passwd" })).toThrow();
  });

  it("reports a failed download on the feed instead of throwing", async () => {
    const { db, actor } = setup();
    const feed = cal.createFeed(db, actor, { name: "Broken", url: "http://127.0.0.1:9/nothing.ics" });
    const r = await cal.refreshFeed(db, actor, feed.id);
    expect(r.error).toBeTruthy();
    expect(cal.listFeeds(db, actor)[0]!.last_error).toBe(r.error);
  });
});

describe("calendar months", () => {
  it("splits nights across months, lets a reservation win over a block, and never counts blocks as booked", () => {
    const { db, actor, viewer } = setup();
    const airbnb = cal.createFeed(db, actor, { name: "Airbnb" });
    const vrbo = cal.createFeed(db, actor, { name: "VRBO" });
    cal.syncFeedText(
      db,
      actor,
      airbnb.id,
      ics(
        // runs from Oct 30 into November: 2 nights in Oct, 2 in Nov, check-in counted in October
        event("r1", "2026-10-30", "2026-11-03", "Reserved"),
        // the VRBO stay below, mirrored as a block
        event("b1", "2026-11-10", "2026-11-13", "Airbnb (Not available)"),
        // an owner stay blocked on Airbnb
        event("b2", "2026-11-20", "2026-11-22", "Airbnb (Not available)"),
      ),
      "2026-10-01",
    );
    cal.syncFeedText(
      db,
      actor,
      vrbo.id,
      ics(
        event("v1", "2026-11-10", "2026-11-13", "Reserved - Jane D"),
        event("vb", "2026-10-30", "2026-11-03", "Blocked"),
      ),
      "2026-10-01",
    );

    const c = cal.getCalendar(db, actor, { from_month: "2026-10", to_month: "2026-11" });
    const [oct, nov] = c.months;
    expect(oct).toMatchObject({ nights: 31, booked_nights: 2, blocked_nights: 0, check_ins: 1 });
    expect(nov).toMatchObject({
      nights: 30,
      booked_nights: 2 + 3, // Nov 1-2 + the VRBO stay
      blocked_nights: 2,
      free_nights: 30 - 5 - 2,
      check_ins: 1, // the VRBO stay; r1 checked in in October
    });
    expect(cal.getCalendar(db, actor, { from_month: "2026-11" }).months[0]!.check_ins).toBe(1);
    const v1 = c.events.find((e) => e.summary.startsWith("Reserved - Jane"))!;
    expect(c.nights["2026-11-10"]).toBe(v1.id);
    // viewers can read it too
    expect(cal.getCalendar(db, viewer, { from_month: "2026-11" }).months[0]!.booked_nights).toBe(5);
  });

  it("drops a feed's events with the feed", () => {
    const { db, actor } = setup();
    const feed = cal.createFeed(db, actor, { name: "Airbnb" });
    cal.syncFeedText(db, actor, feed.id, ics(event("r1", "2026-11-01", "2026-11-03", "Reserved")), "2026-10-01");
    expect(cal.listFeeds(db, actor)[0]!.events).toBe(1);
    cal.deleteFeed(db, actor, feed.id);
    expect(cal.listEvents(db, { from: "2026-01-01", to: "2027-01-01" })).toEqual([]);
  });
});
