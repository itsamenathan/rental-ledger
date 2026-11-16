import { describe, expect, it } from "vite-plus/test";
import { generate, harnessPort } from "./harness.ts";

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

  it("gives each worktree a stable port", () => {
    const p = harnessPort();
    expect(p).toBe(harnessPort());
    expect(p).toBeGreaterThanOrEqual(5200);
    expect(p).toBeLessThan(5900);
  });
});
