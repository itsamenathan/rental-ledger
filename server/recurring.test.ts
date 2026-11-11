import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { users } = await import("./db/schema.ts");
const ledger = await import("./services/ledger.ts");
const { recurring, monthChecklist, dismiss } = await import("./services/recurring.ts");
const { monthDetail, categoryMonths } = await import("./services/reports.ts");

const TODAY = "2026-11-11";

function setup() {
  const db = openDb(":memory:");
  seedDefaults(db);
  const user = db.insert(users).values({ email: "t@example.com", role: "admin" }).returning().get();
  const actor = { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  const add = (date: string, amount: number, category: string, extra: Record<string, unknown> = {}) =>
    ledger.createTransaction(db, null, { date, amount, category, ...extra });
  return { db, actor, add };
}

const months = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const idx = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1 + i;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
  });

describe("recurring detection", () => {
  it("learns a monthly bill and flags a missing month", () => {
    const { db, add } = setup();
    for (const m of months("2025-11", 13))
      if (m !== "2026-08") add(`${m}-01`, -69.95, "Utilities", { subcategory: "Internet" });
    const r = recurring(db, { today: TODAY });
    const internet = r.series.find((s) => s.label === "Utilities: Internet")!;
    expect(internet).toMatchObject({ cadence: 1, typical_amount: -69.95, fixed_amount: true, status: "missing" });
    expect(internet.missing_months).toEqual(["2026-08"]);
    expect(internet.next_due).toBe("2026-12-01");
    expect(r.alerts).toEqual([expect.objectContaining({ type: "missing", month: "2026-08" })]);

    const aug = monthChecklist(db, "2026-08", { today: TODAY });
    expect(aug.items).toEqual([expect.objectContaining({ label: "Utilities: Internet", state: "missing" })]);
    const nov = monthChecklist(db, "2026-11", { today: TODAY });
    expect(nov.items[0]).toMatchObject({ state: "paid", amount: -69.95 });
  });

  it("does not flag a bill that isn't due yet (grace period)", () => {
    const { db, add } = setup();
    // paid on the 20th each month; on Nov 11 the November bill isn't late yet
    for (const m of months("2026-01", 10)) add(`${m}-20`, -30, "Utilities", { subcategory: "Gas" });
    const s = recurring(db, { today: TODAY }).series[0]!;
    expect(s.status).toBe("ok");
    expect(s.next_due).toBe("2026-11-20");
    expect(monthChecklist(db, "2026-11", { today: TODAY }).items[0]).toMatchObject({ state: "upcoming" });
  });

  it("detects quarterly bills and a cadence change", () => {
    const { db, add } = setup();
    for (const m of months("2025-01", 6)) add(`${m}-01`, -52.16, "Utilities", { subcategory: "Sewer" });
    for (const m of ["2025-08", "2025-11", "2026-02", "2026-05", "2026-08"])
      add(`${m}-20`, -168.5, "Utilities", { subcategory: "Sewer" });
    const s = recurring(db, { today: TODAY }).series[0]!;
    expect(s).toMatchObject({ cadence: 3, cadence_label: "Quarterly", status: "ok", next_due: "2026-11-20" });
    expect(s.missing_months).toEqual([]);
  });

  it("ignores irregular spending and one-offs", () => {
    const { db, add } = setup();
    for (const d of [
      "2025-01-05",
      "2025-04-02",
      "2025-06-30",
      "2025-07-31",
      "2025-09-30",
      "2026-01-31",
      "2026-06-30",
      "2026-07-31",
      "2026-08-31",
      "2026-09-30",
    ])
      add(d, -150, "Platform Fees", { vendor: "VRBO" });
    for (const d of ["2026-01-29", "2026-05-15", "2026-09-06"]) add(d, -500, "Furnishings");
    expect(recurring(db, { today: TODAY }).series).toEqual([]);
  });

  it("flags exact duplicates and amount changes", () => {
    const { db, add } = setup();
    for (const m of months("2026-01", 10)) add(`${m}-05`, m === "2026-10" ? -2766.37 : -2617.57, "Mortgage");
    add("2026-05-06", -2617.57, "Mortgage");
    const r = recurring(db, { today: TODAY });
    expect(r.alerts.map((a) => [a.type, a.month])).toEqual(
      expect.arrayContaining([
        ["duplicate", "2026-05"],
        ["amount_changed", "2026-10"],
      ]),
    );
  });

  it("learns from dismissals", () => {
    const { db, actor, add } = setup();
    for (const m of months("2025-11", 13))
      if (m !== "2026-08") add(`${m}-01`, -69.95, "Utilities", { subcategory: "Internet" });
    const key = recurring(db, { today: TODAY }).series[0]!.key;
    dismiss(db, actor, { series_key: key, month: "2026-08" });
    let r = recurring(db, { today: TODAY });
    expect(r.alerts).toEqual([]);
    expect(r.series[0]!.status).toBe("ok");
    expect(monthChecklist(db, "2026-08", { today: TODAY }).items[0]).toMatchObject({ state: "skipped" });
    dismiss(db, actor, { series_key: key });
    r = recurring(db, { today: TODAY });
    expect(r.series[0]!.status).toBe("ignored");
  });
});

describe("month and category reports", () => {
  it("summarises a month against last year and the trailing average", () => {
    const { db, add } = setup();
    add("2025-10-03", 1000, "Rental Income");
    add("2026-10-03", 1500, "Rental Income");
    add("2026-10-04", -200, "Cleaning");
    add("2026-09-04", -100, "Cleaning");
    const d = monthDetail(db, "2026-10");
    expect(d.totals).toMatchObject({ income: 1500, expense: 200, net: 1300 });
    expect(d.compare.same_month_last_year).toMatchObject({ month: "2025-10", income: 1000 });
    expect(d.compare.previous_month).toMatchObject({ month: "2026-09", expense: 100 });
    expect(d.by_category.find((c) => c.category === "Cleaning")).toMatchObject({ amount: -200, count: 1 });
  });

  it("builds a category × month grid with subcategories", () => {
    const { db, add } = setup();
    add("2026-01-05", -80, "Utilities", { subcategory: "Electric" });
    add("2026-02-05", -90, "Utilities", { subcategory: "Electric" });
    add("2026-02-07", -70, "Utilities", { subcategory: "Internet" });
    add("2025-02-07", -60, "Utilities", { subcategory: "Internet" });
    const g = categoryMonths(db, 2026);
    const electric = g.rows.find((r) => r.subcategory === "Electric")!;
    expect(electric.months.slice(0, 3)).toEqual([80, 90, 0]);
    expect(electric.total).toBe(170);
    expect(g.rows.find((r) => r.subcategory === "Internet")).toMatchObject({ total: 70, prev_total: 60 });
  });
});

describe("amount search", () => {
  it("parses amount expressions", () => {
    expect(ledger.parseAmountSearch("69.95")).toEqual({ min: 6995, max: 6995 });
    expect(ledger.parseAmountSearch("$70")).toEqual({ min: 7000, max: 7099 });
    expect(ledger.parseAmountSearch("100-50")).toEqual({ min: 5000, max: 10000 });
    expect(ledger.parseAmountSearch(">500")).toEqual({ min: 50001 });
    expect(ledger.parseAmountSearch("<=20")).toEqual({ max: 2000 });
    expect(ledger.parseAmountSearch("~100")).toEqual({ min: 9000, max: 11000 });
    expect(ledger.parseAmountSearch("1,200.50")).toEqual({ min: 120050, max: 120050 });
    expect(ledger.parseAmountSearch("abc")).toBeNull();
  });

  it("filters transactions by amount, ignoring sign", () => {
    const { db, add } = setup();
    add("2026-01-01", -69.95, "Utilities", { subcategory: "Internet" });
    add("2026-01-02", -70.5, "Supplies");
    add("2026-01-03", 1200, "Rental Income");
    const find = (q: Record<string, string>) =>
      ledger
        .listTransactions(db, q)
        .items.map((t) => t.amount)
        .sort((a, b) => a - b);
    expect(find({ amount: "69.95" })).toEqual([-69.95]);
    expect(find({ amount: "70" })).toEqual([-70.5]);
    expect(find({ amount: "~70" })).toEqual([-70.5, -69.95]);
    expect(find({ amount: ">1000" })).toEqual([1200]);
    expect(find({ q: "$1,200" })).toEqual([1200]);
    expect(() => find({ amount: "lots" })).toThrow(/Amount search/);
  });
});
