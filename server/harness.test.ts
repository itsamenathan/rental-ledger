import { describe, expect, it } from "vite-plus/test";
import { generate, harnessPort, sampleIcs } from "./harness.ts";

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
    expect(nights).toBe(data.occupancy.find((o) => o.month === "2026-10")!.nights_booked);
    expect(data.stays.some((s) => s.start > "2027-01-01")).toBe(true);
    expect(data.ownerStays.some((s) => s.start > "2026-11-16")).toBe(true);
    const ics = sampleIcs(data, "airbnb");
    expect(ics).toContain("SUMMARY:Reserved");
    expect(ics).toContain("SUMMARY:Airbnb (Not available)");
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

  it("gives each worktree a stable port", () => {
    const p = harnessPort();
    expect(p).toBe(harnessPort());
    expect(p).toBeGreaterThanOrEqual(5200);
    expect(p).toBeLessThan(5900);
  });
});
