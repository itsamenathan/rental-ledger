import { describe, expect, it } from "vite-plus/test";
import { generate, harnessPort, sampleIcs, sampleReservationsCsv } from "./harness.ts";
import { parseReservationsCsv } from "./services/calendar.ts";

describe("test harness data", () => {
  const today = new Date("2026-11-16T12:00:00Z");

  it("is the same on every run and stops at today", () => {
    const a = generate(today);
    expect(generate(today)).toEqual(a);
    expect(a.rows[0]!.date).toBe("2024-01-01");
    expect(a.rows.every((r) => r.date <= "2026-11-16")).toBe(true);
    expect(a.occupancy.at(-1)!.month).toBe("2026-10");
  });

  it("includes the To do scenarios", () => {
    const { rows } = generate(today);
    const internet = rows.filter((r) => r.subcategory === "Internet").map((r) => r.date.slice(0, 7));
    expect(internet).not.toContain("2026-10");
    expect(internet).toContain("2026-09");
    expect(rows.filter((r) => r.subcategory === "Electric" && r.date.startsWith("2026-09"))).toHaveLength(2);
    expect(rows.some((r) => r.needs_review)).toBe(true);
    expect(rows.some((r) => r.allocation === null)).toBe(true);
    expect(rows.some((r) => r.trash)).toBe(true);
  });

  it("includes receipt-rule scenarios", () => {
    const { rows, subcategoryRules } = generate(today);
    for (const r of subcategoryRules)
      expect(rows.some((x) => x.category === r.category && x.subcategory === r.name)).toBe(true);
    expect(rows.some((r) => r.vendor === "Stripe" && r.amount <= -75)).toBe(true);
    expect(rows.some((r) => r.refund && r.amount > 0 && r.category === "Maintenance")).toBe(true);
  });

  it("puts every stay on the booking calendar, matching occupancy", () => {
    const data = generate(today);
    const oct = data.stays.filter((s) => s.start.startsWith("2026-10"));
    const nights = oct.reduce((n, s) => n + (Date.parse(s.end) - Date.parse(s.start)) / 86_400_000, 0);
    // last month's typed guest nights are 2 short of the calendar, for "Guest nights" on the Occupancy page
    expect(nights).toBe(data.occupancy.find((o) => o.month === "2026-10")!.nights_booked + 2);
    expect(data.occupancy.find((o) => o.month === "2026-09")!.nights_booked).toBe(
      data.stays
        .filter((s) => s.start.startsWith("2026-09"))
        .reduce((n, s) => n + (Date.parse(s.end) - Date.parse(s.start)) / 86_400_000, 0),
    );
    expect(data.stays.some((s) => s.start > "2027-01-01")).toBe(true);
    expect(data.ownerStays.some((s) => s.start > "2026-11-16")).toBe(true);
    const ics = sampleIcs(data, "airbnb");
    expect(ics).toContain("SUMMARY:Reserved");
    expect(ics).toContain("SUMMARY:Airbnb (Not available)");
  });

  it("leaves last month an owner block on both calendars and a hold on Airbnb only, to confirm", () => {
    const data = generate(today);
    const block = data.ownerStays.find((o) => o.start.startsWith("2026-10"))!;
    expect(block).toBeDefined();
    expect(data.occupancy.find((o) => o.month === "2026-10")!.owner_nights).toBe(0);
    expect(data.holds).toHaveLength(1);
    expect(data.holds[0]!.start > block.end).toBe(true);
    expect(data.holds[0]!.end <= "2026-10-31").toBe(true);
    expect(sampleIcs(data, "airbnb")).toContain(`airbnb-hold-${data.holds[0]!.start}`);
    expect(sampleIcs(data, "vrbo")).not.toContain("hold");
  });

  it("keeps only recent Airbnb stays in the feed, with the full history in a reservations export", () => {
    const data = generate(today);
    const trimmed = sampleIcs(data, "airbnb", [], "2026-09-17");
    expect(trimmed).not.toContain("DTSTART;VALUE=DATE:2024");
    expect(trimmed).toContain("SUMMARY:Reserved");
    const rows = parseReservationsCsv(sampleReservationsCsv(data, "Harbor View Cottage", "2026-11-16"));
    expect(rows.length).toBe(data.stays.filter((s) => s.platform === "airbnb").length + 1);
    expect(rows[0]).toMatchObject({
      start: data.stays[0]!.start,
      listing: "Harbor View Cottage",
      status: "Past guest",
    });
    expect(rows.some((r) => /cancel/i.test(r.status))).toBe(true);
    // the export's codes are the ones in the feed's descriptions
    expect(sampleIcs(data, "airbnb")).toContain(`details/${rows[0]!.code}`);
  });

  it("has a second, smaller property with its own To do item and calendar", () => {
    const { second, rows } = generate(today);
    expect(second.property.name).not.toBe("");
    expect(second.rows[0]!.date >= "2025-01-01").toBe(true);
    expect(second.rows.length).toBeLessThan(rows.length / 2);
    expect(second.rows.filter((r) => r.needs_review)).toHaveLength(1);
    expect(second.occupancy.at(-1)!.month).toBe("2026-10");
    expect(sampleIcs(second, "airbnb")).toContain("SUMMARY:Reserved");
  });

  it("has manager statements for a paid and an unpaid state tax quarter, with a direct booking across them", () => {
    const data = generate(today);
    expect(data.stateTax.paid).toEqual({ year: 2026, quarter: 2 });
    expect(data.stateTax.unpaid).toEqual({ year: 2026, quarter: 3 }); // due Oct 20: overdue on Nov 16
    expect(data.statements.map((s) => s.month)).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    // checks in Jun 29 (Q2), out Jul 2: on July's statement
    expect(data.directStays).toEqual([{ start: "2026-06-29", end: "2026-07-02", payout: 735 }]);
    const july = data.statements.find((s) => s.month === "2026-07")!.csv;
    expect(july).toContain("Booking Engine,2026-06-29,2026-07-02");
    for (const ch of ["Airbnb", "VRBO", "Booking Engine"])
      expect(data.statements.some((s) => s.csv.includes(`,${ch},`))).toBe(true);
    // no stay overlaps the direct booking, and occupancy counts its nights in June (2) and July (1)
    expect(data.stays.some((s) => s.start < "2026-07-02" && s.end > "2026-06-29")).toBe(false);
    const nights = (month: string) =>
      data.stays
        .filter((s) => s.start.startsWith(month))
        .reduce((n, s) => n + (Date.parse(s.end) - Date.parse(s.start)) / 86_400_000, 0);
    expect(data.occupancy.find((o) => o.month === "2026-06")!.nights_booked).toBe(nights("2026-06") + 2);
    expect(data.occupancy.find((o) => o.month === "2026-07")!.nights_booked).toBe(nights("2026-07") + 1);
    expect(data.rows.some((r) => r.subcategory === "Direct booking" && r.amount === 735)).toBe(true);
  });

  it("gives each worktree a stable port", () => {
    const p = harnessPort();
    expect(p).toBe(harnessPort());
    expect(p).toBeGreaterThanOrEqual(5200);
    expect(p).toBeLessThan(5900);
  });
});
