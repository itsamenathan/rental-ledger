import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { users, occupancy, properties } = await import("./db/schema.ts");
const cal = await import("./services/calendar.ts");
const stays = await import("./services/owner-stays.ts");
const occCal = await import("./services/occupancy-calendar.ts");
const rental = await import("./services/rental.ts");
const reports = await import("./services/reports.ts");
const ledger = await import("./services/ledger.ts");
const { eq } = await import("drizzle-orm");
const { todoSummary } = await import("./services/todo.ts");

const TODAY = "2026-11-20";

function setup() {
  const db = openDb(":memory:");
  seedDefaults(db);
  const user = db.insert(users).values({ email: "t@example.com", role: "admin" }).returning().get();
  const actor = { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  const pid = db.select({ id: properties.id }).from(properties).get()!.id;
  return { db, actor, pid };
}

const event = (uid: string, start: string, end: string, summary: string) =>
  [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART;VALUE=DATE:${start.replace(/-/g, "")}`,
    `DTEND;VALUE=DATE:${end.replace(/-/g, "")}`,
    `SUMMARY:${summary}`,
    "END:VEVENT",
  ].join("\r\n");
const ics = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");

function feed(
  db: ReturnType<typeof setup>["db"],
  actor: ReturnType<typeof setup>["actor"],
  pid: number,
  name: string,
  events: string[],
) {
  const f = cal.createFeed(db, actor, { property_id: pid, name });
  cal.syncFeedText(db, actor, f.id, ics(...events), TODAY);
  return f;
}

describe("nights rule", () => {
  it("counts the check-in night and not the checkout day", () => {
    expect([...stays.nightsByMonth("2026-03-03", "2026-03-06")]).toEqual([["2026-03", 3]]);
    expect([...stays.nightsByMonth("2026-03-31", "2026-04-01")]).toEqual([["2026-03", 1]]);
  });

  it("splits a stay by each night's month and year", () => {
    expect([...stays.nightsByMonth("2025-12-30", "2026-01-02")]).toEqual([
      ["2025-12", 2],
      ["2026-01", 1],
    ]);
    expect([...stays.nightsByMonth("2026-01-30", "2026-03-02")]).toEqual([
      ["2026-01", 2],
      ["2026-02", 28],
      ["2026-03", 1],
    ]);
    expect(stays.nightsInYear("2025-12-30", "2026-01-02", 2025)).toBe(2);
    expect(stays.nightsInYear("2025-12-30", "2026-01-02", 2026)).toBe(1);
    expect(stays.nightsInYear("2025-12-30", "2026-01-02", 2027)).toBe(0);
  });

  it("formats personal-use ranges for the preparer", () => {
    const r = stays.personalUseRanges([
      { start_date: "2026-03-05", end_date: "2026-03-08", nights_in_year: 3 },
      { start_date: "2026-07-02", end_date: "2026-07-09", nights_in_year: 7 },
      { start_date: "2026-12-30", end_date: "2027-01-02", nights_in_year: 2 },
    ]);
    expect(r.text).toBe("Mar 5-8, Jul 2-9, Dec 30-Jan 2");
    expect(r.nights).toBe(12);
  });
});

describe("owner stays", () => {
  it("rejects overlaps within a property, allows back-to-back stays and other properties", () => {
    const { db, actor, pid } = setup();
    const other = ledger.createProperty(db, actor, { name: "Other" }).id;
    const a = stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2026-03-03", end_date: "2026-03-06" });
    expect(a.stay.nights).toBe(3);
    expect(() =>
      stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2026-03-05", end_date: "2026-03-07" }),
    ).toThrow(/Overlaps/);
    expect(() =>
      stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2026-03-01", end_date: "2026-03-10" }),
    ).toThrow(/Overlaps/);
    // checkout day = next check-in is fine
    stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2026-03-06", end_date: "2026-03-08" });
    stays.addOwnerStay(db, actor, { property_id: other, start_date: "2026-03-04", end_date: "2026-03-05" });
    expect(() =>
      stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2026-03-10", end_date: "2026-03-10" }),
    ).toThrow(/checkout/);
    // an edit doesn't clash with itself
    expect(stays.updateOwnerStay(db, actor, a.stay.id, { start_date: "2026-03-02" }).stay.nights).toBe(4);
    expect(() => stays.updateOwnerStay(db, actor, a.stay.id, { end_date: "2026-03-07" })).toThrow(/Overlaps/);
  });

  it("warns, without refusing, when a stay overlaps guest nights on the calendar", () => {
    const { db, actor, pid } = setup();
    feed(db, actor, pid, "Airbnb", [event("g1", "2026-04-10", "2026-04-13", "Reserved")]);
    const r = stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2026-04-12", end_date: "2026-04-15" });
    expect(r.stay.id).toBeGreaterThan(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^1 night\(s\) overlap a guest stay/);
    expect(
      stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2026-04-15", end_date: "2026-04-16" }).warnings,
    ).toEqual([]);
  });
});

describe("derived owner nights", () => {
  it("uses the stays for months they touch, else the typed number, and brings it back when removed", () => {
    const { db, actor, pid } = setup();
    rental.upsertOccupancy(db, actor, { property_id: pid, month: "2026-03", nights_booked: 10, owner_nights: 5 });
    rental.upsertOccupancy(db, actor, { property_id: pid, month: "2026-04", nights_booked: 8, owner_nights: 2 });
    const s = stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2026-03-30", end_date: "2026-04-01" });
    const row = (m: string) => rental.listOccupancy(db, { year: 2026, property_id: pid }).find((r) => r.month === m)!;
    expect(row("2026-03")).toMatchObject({ owner_nights: 2, owner_nights_source: "stays", manual_owner_nights: 5 });
    // the checkout day (Apr 1) is not a night, so April keeps its typed number
    expect(row("2026-04")).toMatchObject({ owner_nights: 2, owner_nights_source: "manual" });

    // a typed number can't contradict the stays: ignored server-side, the stored one is kept
    const saved = rental.upsertOccupancy(db, actor, {
      property_id: pid,
      month: "2026-03",
      nights_booked: 11,
      owner_nights: 9,
    });
    expect(saved).toMatchObject({ nights_booked: 11, owner_nights: 2, manual_owner_nights: 5 });
    expect(db.select().from(occupancy).where(eq(occupancy.month, "2026-03")).get()!.ownerNights).toBe(5);

    expect(reports.occupancyTotals(db, 2026, pid).owner_nights).toBe(4);
    // without a year too (GET /api/occupancy, list_occupancy)
    expect(rental.listOccupancy(db, { property_id: pid }).find((r) => r.month === "2026-03")).toMatchObject({
      owner_nights: 2,
      owner_nights_source: "stays",
    });
    expect(rental.listOccupancy(db, {}).find((r) => r.month === "2026-03")!.owner_nights).toBe(2);
    stays.deleteOwnerStay(db, actor, s.stay.id);
    expect(row("2026-03")).toMatchObject({ owner_nights: 5, owner_nights_source: "manual" });
    expect(reports.occupancyTotals(db, 2026, pid).owner_nights).toBe(7);
  });

  it("splits personal days across tax years and counts months with stays but no saved row", () => {
    const { db, actor, pid } = setup();
    rental.upsertOccupancy(db, actor, { property_id: pid, month: "2025-12", nights_booked: 20, owner_nights: 0 });
    const rateBefore = reports.occupancyTotals(db, 2025, pid).occupancy_rate;
    stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2025-12-30", end_date: "2026-01-02" });
    expect(reports.taxReport(db, 2025, pid).use.personal_days).toBe(2);
    const t2026 = reports.taxReport(db, 2026, pid);
    expect(t2026.use.personal_days).toBe(1);
    expect(t2026.use.owner_stays).toEqual([
      { start_date: "2025-12-30", end_date: "2026-01-02", nights_in_year: 1, kind: null },
    ]);
    // January has no saved row: personal nights count, guest nights are still "missing"
    const jan = rental.listOccupancy(db, { year: 2026, property_id: pid });
    expect(jan).toEqual([expect.objectContaining({ id: null, month: "2026-01", owner_nights: 1, recorded: false })]);
    expect(t2026.checks.map((c) => c.code)).toContain("missing_occupancy");
    expect(reports.occupancyTotals(db, 2026, pid)).toMatchObject({ months_recorded: 0, owner_nights: 1 });
    // December's rate now leaves out the 2 owner nights from the available ones
    expect(reports.occupancyTotals(db, 2025, pid).occupancy_rate).toBeGreaterThan(rateBefore!);
  });

  it("decides stays vs typed numbers per property when adding up every property", () => {
    const { db, actor, pid } = setup();
    const other = ledger.createProperty(db, actor, { name: "Other" }).id;
    rental.upsertOccupancy(db, actor, { property_id: pid, month: "2026-03", nights_booked: 10, owner_nights: 6 });
    rental.upsertOccupancy(db, actor, { property_id: other, month: "2026-03", nights_booked: 9, owner_nights: 4 });
    stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2026-03-03", end_date: "2026-03-06" });
    expect(reports.occupancyTotals(db, 2026).owner_nights).toBe(3 + 4);
    const march = reports.summary(db, 2026).monthly.find((m) => m.month === "2026-03")!;
    expect(march).toMatchObject({ owner_nights: 7, nights_booked: 19 });
    expect(reports.monthDetail(db, "2026-03", other).occupancy).toMatchObject({ owner_nights: 4 });
    expect(reports.monthDetail(db, "2026-03").occupancy).toMatchObject({ owner_nights: 7 });
  });
});

describe("calendar vs guest nights", () => {
  it("compares only ended months with calendar reservations, and never touches owner nights or notes", () => {
    const { db, actor, pid } = setup();
    feed(db, actor, pid, "Airbnb", [
      event("a1", "2026-08-02", "2026-08-06", "Reserved"),
      event("a2", "2026-08-10", "2026-08-20", "Reserved"),
      event("a3", "2026-09-05", "2026-09-07", "Reserved"),
      event("a4", "2026-11-03", "2026-11-05", "Reserved"),
      event("b1", "2026-10-01", "2026-10-05", "Airbnb (Not available)"),
    ]);
    rental.upsertOccupancy(db, actor, {
      property_id: pid,
      month: "2026-08",
      nights_available: 30,
      nights_booked: 12,
      owner_nights: 3,
      check_ins: 2,
      notes: "keep me",
    });
    rental.upsertOccupancy(db, actor, { property_id: pid, month: "2026-09", nights_booked: 5, check_ins: 2 });
    rental.upsertOccupancy(db, actor, { property_id: pid, month: "2026-10", nights_booked: 6, check_ins: 1 });

    const r = occCal.compareOccupancyCalendar(db, { property_id: pid, year: 2026, today: TODAY });
    const m = (k: string) => r.months.find((x) => x.month === k)!;
    expect(m("2026-08")).toMatchObject({
      status: "differs",
      calendar: { nights_booked: 14, check_ins: 2 },
      stored: { nights_booked: 12, check_ins: 2 },
      calendar_lower: false,
    });
    expect(m("2026-09")).toMatchObject({ status: "differs", calendar_lower: true });
    // only a block in October: no reservation data is "no data", not zero nights
    expect(m("2026-10")).toMatchObject({ status: "no_data", calendar: null });
    expect(m("2026-11")).toMatchObject({ status: "not_ended", calendar: null });
    expect(m("2026-01")).toMatchObject({ status: "no_data" });
    expect(r.differing).toEqual(["2026-08", "2026-09"]);

    stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2026-08-25", end_date: "2026-08-27" });
    const res = occCal.applyCalendarToOccupancy(
      db,
      actor,
      { property_id: pid, months: ["2026-08", "2026-09", "2026-10", "2026-11"] },
      TODAY,
    );
    expect(res.applied.map((a) => a.month)).toEqual(["2026-08"]);
    expect(res.skipped.map((s) => s.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
    const aug = db.select().from(occupancy).where(eq(occupancy.month, "2026-08")).get()!;
    expect(aug).toMatchObject({ nightsBooked: 14, checkIns: 2, ownerNights: 3, notes: "keep me", nightsAvailable: 30 });

    // a lower calendar number needs the explicit confirmation
    occCal.applyCalendarToOccupancy(db, actor, { property_id: pid, months: ["2026-09"], confirm_lower: true }, TODAY);
    expect(db.select().from(occupancy).where(eq(occupancy.month, "2026-09")).get()).toMatchObject({
      nightsBooked: 2,
      checkIns: 1,
      ownerNights: 0,
    });
    expect(occCal.compareOccupancyCalendar(db, { property_id: pid, year: 2026, today: TODAY }).differing).toEqual([]);
  });

  it("marks months a connected calendar doesn't reach back to, unless reservation history covers them", () => {
    const { db, actor, pid } = setup();
    feed(db, actor, pid, "VRBO", [
      event("v0", "2026-02-20", "2026-02-22", "Reserved - Guest"),
      event("v1", "2026-03-05", "2026-03-08", "Reserved - Guest"),
      event("v2", "2026-03-10", "2026-03-14", "Blocked"), // an Airbnb guest Airbnb's feed no longer shows
      event("v3", "2026-10-02", "2026-10-04", "Reserved - Guest"),
    ]);
    feed(db, actor, pid, "Airbnb", [event("a1", "2026-09-25", "2026-09-28", "Reserved")]);
    rental.upsertOccupancy(db, actor, { property_id: pid, month: "2026-03", nights_booked: 7, check_ins: 2 });
    rental.upsertOccupancy(db, actor, { property_id: pid, month: "2026-10", nights_booked: 1, check_ins: 1 });
    const m = (k: string) =>
      occCal
        .compareOccupancyCalendar(db, { property_id: pid, year: 2026, today: TODAY })
        .months.find((x) => x.month === k)!;
    expect(m("2026-03")).toMatchObject({ status: "differs", calendar_lower: true, incomplete: ["Airbnb"] });
    expect(m("2026-10")).toMatchObject({ status: "differs", incomplete: [] });
    // the tax report only mentions the month both calendars cover
    const check = reports.taxReport(db, 2026, pid).checks.find((c) => c.code === "calendar_nights_differ")!;
    expect(check.message).toContain("in 1 month(s)");
    expect(check.message).toContain("Oct 2 vs 1");

    cal.importReservationHistory(
      db,
      actor,
      {
        property_id: pid,
        csv: "Confirmation code,Status,Start date,End date\nHMX1,Past guest,2026-03-10,2026-03-14\n",
      },
      TODAY,
    );
    expect(m("2026-03")).toMatchObject({
      status: "match",
      incomplete: [],
      calendar: { nights_booked: 7, check_ins: 2 },
    });
  });

  it("flags a difference on the tax report as information only", () => {
    const { db, actor, pid } = setup();
    // (a feed's first month counts as incomplete: its export window may have started part-way through)
    feed(db, actor, pid, "Airbnb", [
      event("a0", "2025-07-20", "2025-07-22", "Reserved"),
      event("a1", "2025-08-02", "2025-08-06", "Reserved"),
    ]);
    rental.upsertOccupancy(db, actor, { property_id: pid, month: "2025-08", nights_booked: 2, check_ins: 1 });
    const check = reports.taxReport(db, 2025, pid).checks.find((c) => c.code === "calendar_nights_differ");
    expect(check).toMatchObject({ level: "info" });
    expect(check!.message).toContain("Aug 4 vs 2");
  });
});

describe("owner stays to confirm", () => {
  it("ranks a block on every covering calendar above one only one calendar can see", () => {
    const { db, actor, pid } = setup();
    // VRBO reaches back to January; Airbnb's export only to September (like the real 60-day window)
    feed(db, actor, pid, "VRBO", [
      event("v0", "2026-01-10", "2026-01-12", "Reserved - Guest"),
      event("v1", "2026-03-05", "2026-03-08", "Blocked"), // only VRBO covers March: can't tell
      event("v2", "2026-10-01", "2026-10-04", "Blocked"), // both block: strong
      event("v3", "2026-09-10", "2026-09-14", "Reserved - Guest"), // Airbnb blocks it for this guest: not a candidate
      event("v4", "2026-12-20", "2026-12-27", "Blocked"), // hasn't started
    ]);
    feed(db, actor, pid, "Airbnb", [
      event("a0", "2026-09-01", "2026-09-03", "Reserved"),
      event("a1", "2026-10-01", "2026-10-04", "Airbnb (Not available)"),
      event("a2", "2026-09-10", "2026-09-14", "Airbnb (Not available)"),
      event("a3", "2026-10-20", "2026-10-22", "Airbnb (Not available)"), // VRBO shows it open: weak
      event("a4", "2026-09-03", "2026-09-04", "Airbnb (Not available)"), // 1 night after a guest: turnover
      event("a5", "2026-12-20", "2026-12-27", "Airbnb (Not available)"),
    ]);
    const r = occCal.ownerStayCandidates(db, { property_id: pid, year: 2026, today: TODAY });
    expect(r.candidates.map((c) => [c.start_date, c.end_date, c.signal])).toEqual([
      ["2026-10-01", "2026-10-04", "strong"],
      ["2026-03-05", "2026-03-08", "unclear"],
      ["2026-09-03", "2026-09-04", "weak"],
      ["2026-10-20", "2026-10-22", "weak"],
    ]);
    expect(r.candidates[0]).toMatchObject({ nights: 3, blocked_on: ["VRBO", "Airbnb"], covering: ["VRBO", "Airbnb"] });
    expect(r.candidates[1]!.covering).toEqual(["VRBO"]);
    expect(r.candidates[3]!.reason).toMatch(/VRBO shows it open/);

    // confirmed or dismissed ranges drop out
    stays.addOwnerStay(db, actor, {
      property_id: pid,
      start_date: "2026-10-01",
      end_date: "2026-10-04",
      kind: "owner",
    });
    occCal.dismissCandidate(db, actor, { property_id: pid, start_date: "2026-10-20", end_date: "2026-10-22" });
    const after = occCal.ownerStayCandidates(db, { property_id: pid, year: 2026, today: TODAY });
    expect(after.candidates.map((c) => c.start_date)).toEqual(["2026-03-05", "2026-09-03"]);
    expect(after.dismissed).toHaveLength(1);
    occCal.undismissCandidate(db, actor, after.dismissed[0]!.id);
    expect(occCal.ownerStayCandidates(db, { property_id: pid, year: 2026, today: TODAY }).candidates).toHaveLength(3);
  });

  it("sees a block crossing New Year whole and keeps abutting blocks apart", () => {
    const { db, actor, pid } = setup();
    feed(db, actor, pid, "Airbnb", [
      event("a1", "2025-12-29", "2026-01-03", "Airbnb (Not available)"),
      event("a2", "2026-01-03", "2026-01-05", "Airbnb (Not available)"),
    ]);
    const r = occCal.ownerStayCandidates(db, { property_id: pid, year: 2026, today: TODAY });
    expect(r.candidates.map((c) => [c.start_date, c.end_date, c.nights, c.nights_in_year])).toEqual([
      ["2025-12-29", "2026-01-03", 5, 2],
      ["2026-01-03", "2026-01-05", 2, 2],
    ]);
  });

  it("rankBlock: signal rules", () => {
    const base = { nights: 3, next_to_guest: false };
    expect(occCal.rankBlock({ ...base, blocked_on: ["A", "B"], covering: ["A", "B"] }).signal).toBe("strong");
    expect(occCal.rankBlock({ ...base, blocked_on: ["A"], covering: ["A", "B"] }).signal).toBe("weak");
    expect(occCal.rankBlock({ ...base, blocked_on: ["A"], covering: ["A"] }).signal).toBe("unclear");
    expect(
      occCal.rankBlock({ ...base, nights: 1, next_to_guest: true, blocked_on: ["A", "B"], covering: ["A", "B"] })
        .signal,
    ).toBe("weak");
    expect(occCal.rankBlock({ ...base, nights: 60, blocked_on: ["A", "B"], covering: ["A", "B"] }).signal).toBe("weak");
  });
});

describe("To do", () => {
  it("lists likely owner stays and fully covered months that disagree, and drops them once handled", () => {
    const { db, actor, pid } = setup();
    feed(db, actor, pid, "VRBO", [
      event("v0", "2026-07-01", "2026-07-03", "Reserved - Guest"),
      event("v1", "2026-09-05", "2026-09-08", "Blocked"), // both block: likely owner
      event("v2", "2026-10-20", "2026-10-22", "Reserved - Guest"),
    ]);
    feed(db, actor, pid, "Airbnb", [
      event("a0", "2026-08-01", "2026-08-03", "Reserved"),
      event("a1", "2026-09-05", "2026-09-08", "Airbnb (Not available)"),
      event("a2", "2026-10-03", "2026-10-06", "Reserved"),
      event("a3", "2026-10-20", "2026-10-22", "Airbnb (Not available)"),
      event("a4", "2026-10-25", "2026-10-27", "Airbnb (Not available)"), // Airbnb only: not on To do
    ]);
    rental.upsertOccupancy(db, actor, { property_id: pid, month: "2026-10", nights_booked: 3, check_ins: 1 });
    const before = todoSummary(db, { propertyId: pid, today: TODAY });
    const [item] = before.occupancy_items;
    expect(item!.owner_stays.map((c) => c.start_date)).toEqual(["2026-09-05"]);
    // July is VRBO's first month (incomplete), August has a stay but nothing saved, October is 3 nights vs 3+2
    expect(item!.guest_nights.map((m) => [m.month, m.stored?.nights_booked ?? null])).toEqual([
      ["2026-08", null],
      ["2026-10", 3],
    ]);
    expect(before.occupancy).toBe(3);

    stays.addOwnerStay(db, actor, { property_id: pid, start_date: "2026-09-05", end_date: "2026-09-08" });
    occCal.applyCalendarToOccupancy(db, actor, { property_id: pid, months: ["2026-08", "2026-10"] }, TODAY);
    const after = todoSummary(db, { propertyId: pid, today: TODAY });
    expect(after.occupancy).toBe(0);
    expect(after.total).toBe(before.total - 3);
  });
});
