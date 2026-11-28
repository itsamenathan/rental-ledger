import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { TEST_CATEGORIES } = await import("./test-categories.ts");
const { users } = await import("./db/schema.ts");
const ledger = await import("./services/ledger.ts");
const files = await import("./services/attachments.ts");
const library = await import("./services/files.ts");
const reports = await import("./services/reports.ts");
const receipts = await import("./services/receipts.ts");
const cats = await import("./services/categories.ts");
const { todoSummary } = await import("./services/todo.ts");
const { undoAudit } = await import("./services/undo.ts");

function setup() {
  const db = openDb(":memory:");
  seedDefaults(db, TEST_CATEGORIES);
  const user = db.insert(users).values({ email: "t@example.com", role: "admin" }).returning().get();
  const actor = { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  const add = (category: string, amount: number, extra: Record<string, unknown> = {}) =>
    ledger.createTransaction(db, actor, { date: "2026-06-15", amount, category, ...extra }).id;
  const cat = (name: string) => ledger.resolveCategory(db, name);
  const needing = () => receipts.missingReceiptIds(db);
  return { db, actor, add, cat, needing };
}

describe("transaction list", () => {
  it("marks each entry that still needs a receipt", () => {
    const { db, add, needing } = setup();
    const big = add("Maintenance", -200);
    const small = add("Maintenance", -10);
    const income = add("Rental Income", 500);
    const flag = () =>
      Object.fromEntries(ledger.listTransactions(db, { month: "2026-06" }).items.map((i) => [i.id, i.needs_receipt]));
    expect(flag()).toEqual({ [big]: true, [small]: false, [income]: false });
    expect(needing()).toEqual([big]);
  });

  it("counts each quick filter under the other filters, whichever one is picked", () => {
    const { db, add } = setup();
    add("Maintenance", -200, { needs_review: true });
    add("Maintenance", -10);
    add("Rental Income", 500, { needs_review: true });
    add("Maintenance", -300, { date: "2025-06-01" });
    const want = { all: 3, income: 1, expense: 2, needs_review: 2, needs_receipt: 1 };
    expect(ledger.listTransactions(db, { year: "2026", counts: "true" }).counts).toEqual(want);
    const picked = ledger.listTransactions(db, { year: "2026", kind: "income", counts: "true" });
    expect(picked.total).toBe(1);
    expect(picked.counts).toEqual(want);
    expect(ledger.listTransactions(db, { year: "2026" })).not.toHaveProperty("counts");
  });

  it("can list just the given entries", () => {
    const { db, add } = setup();
    const a = add("Maintenance", -20);
    add("Maintenance", -30);
    const c = add("Rental Income", 100);
    const ids = (q: Record<string, unknown>) =>
      ledger
        .listTransactions(db, q)
        .items.map((i) => i.id)
        .sort((x, y) => x - y);
    expect(ids({ ids: `${a},${c}` })).toEqual([a, c].sort((x, y) => x - y));
    expect(ids({ ids: [c] })).toEqual([c]);
  });
});

describe("receipt policy", () => {
  it("defaults to the $75 threshold, and mortgage (line 12) to never", () => {
    const { add, cat, needing } = setup();
    expect(cat("Maintenance").receipt_policy).toBe("threshold");
    expect(cat("Maintenance").receipt_min).toBeNull();
    expect(cat("Mortgage").receipt_policy).toBe("never");
    const big = add("Maintenance", -75);
    add("Maintenance", -74.99);
    add("Mortgage", -2500);
    expect(needing()).toEqual([big]);
  });

  it("threshold uses the category's own amount when set", () => {
    const { db, actor, add, cat, needing } = setup();
    ledger.updateCategory(db, actor, cat("Supplies").id, { receipt_min: 20 });
    expect(cat("Supplies").receipt_min).toBe(20);
    const a = add("Supplies", -20);
    add("Supplies", -19.99);
    expect(needing()).toEqual([a]);
    ledger.updateCategory(db, actor, cat("Supplies").id, { receipt_min: null });
    expect(needing()).toEqual([]);
  });

  it("always asks at any amount; never asks at no amount", () => {
    const { db, actor, add, cat, needing } = setup();
    ledger.updateCategory(db, actor, cat("Supplies").id, { receipt_policy: "always" });
    ledger.updateCategory(db, actor, cat("Maintenance").id, { receipt_policy: "never" });
    const small = add("Supplies", -3.5);
    add("Maintenance", -5000);
    expect(needing()).toEqual([small]);
  });

  it("only asks for outflows, not refunds or income, and not once a receipt is attached", async () => {
    const { db, actor, add, needing } = setup();
    add("Maintenance", 200, { refund: true });
    add("Rental Income", 500);
    const paid = add("Maintenance", -200);
    expect(needing()).toEqual([paid]);
    await files.addAttachment(db, actor, paid, {
      filename: "r.pdf",
      contentType: "application/pdf",
      data: new TextEncoder().encode("receipt"),
    });
    expect(needing()).toEqual([]);
  });

  it("keeps the policy when other fields change, and new line-12 categories default to never", () => {
    const { db, actor, cat } = setup();
    ledger.updateCategory(db, actor, cat("Supplies").id, { receipt_policy: "never" });
    ledger.updateCategory(db, actor, cat("Supplies").id, { name: "Supplies & Linens", description: "x" });
    expect(cat("Supplies & Linens").receipt_policy).toBe("never");
    const heloc = ledger.createCategory(db, actor, { name: "HELOC", kind: "expense", schedule_e_line: "12" });
    expect(heloc.receipt_policy).toBe("never");
    const explicit = ledger.createCategory(db, actor, {
      name: "Second mortgage",
      kind: "expense",
      schedule_e_line: "12",
      receipt_policy: "threshold",
    });
    expect(explicit.receipt_policy).toBe("threshold");
  });

  it("rejects an unknown policy or a non-positive threshold", () => {
    const { db, actor, cat } = setup();
    expect(() => ledger.updateCategory(db, actor, cat("Supplies").id, { receipt_policy: "sometimes" })).toThrow();
    expect(() => ledger.updateCategory(db, actor, cat("Supplies").id, { receipt_min: 0 })).toThrow();
  });
});

describe("subcategory rules", () => {
  const rule = (category: string, name: string, receipt_policy: string, receipt_min?: number | null) =>
    ({ category, name, receipt_policy, receipt_min }) as const;

  it("inherit the category's rule until a subcategory has its own", () => {
    const { db, actor, add, needing } = setup();
    const sewer = add("Utilities", -168.5, { subcategory: "Sewer" });
    const electric = add("Utilities", -60, { subcategory: "Electric" });
    const gas = add("Utilities", -150, { subcategory: "Gas" });
    expect(needing()).toEqual([sewer, gas]);

    cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "sewer", "never"));
    cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "Electric", "always"));
    cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "Gas", "threshold", 200));
    expect(needing()).toEqual([electric]);

    // back to the category's rule
    cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "Sewer", "inherit"));
    expect(needing()).toEqual([sewer, electric]);
  });

  it("a subcategory threshold with no amount uses the category's amount", () => {
    const { db, actor, add, cat, needing } = setup();
    ledger.updateCategory(db, actor, cat("Utilities").id, { receipt_policy: "never", receipt_min: 100 });
    add("Utilities", -90, { subcategory: "Water" });
    const big = add("Utilities", -110, { subcategory: "Water" });
    add("Utilities", -500, { subcategory: "Gas" });
    cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "Water", "threshold"));
    expect(needing()).toEqual([big]);
  });

  it("is per category: the same name elsewhere keeps its own rule", () => {
    const { db, actor, add, needing } = setup();
    add("Utilities", -100, { subcategory: "Trash" });
    const services = add("Services", -100, { subcategory: "Trash" });
    cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "Trash", "never"));
    expect(needing()).toEqual([services]);
  });

  it("saves a used-only subcategory with its spelling and lists the rule", () => {
    const { db, actor, add } = setup();
    add("Utilities", -100, { subcategory: "Sewer" });
    const r = cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "SEWER", "threshold", 150));
    expect(r).toMatchObject({ name: "Sewer", receipt_policy: "threshold", receipt_min: 150 });
    const listed = cats.listSubcategories(db).filter((x) => x.name === "Sewer");
    expect(listed).toEqual([
      expect.objectContaining({ count: 1, saved: true, receipt_policy: "threshold", receipt_min: 150 }),
    ]);
    // an amount only means something for threshold
    cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "Sewer", "always", 150));
    expect(cats.listSubcategories(db).find((x) => x.name === "Sewer")?.receipt_min).toBeNull();
  });

  it("refuses income categories and bad input", () => {
    const { db, actor } = setup();
    expect(() => cats.setSubcategoryReceiptRule(db, actor, rule("Rental Income", "Airbnb", "never"))).toThrow();
    expect(() => cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "Sewer", "sometimes"))).toThrow();
    expect(() => cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "Sewer", "threshold", 0))).toThrow();
  });

  it("keeps the rule through a rename, the target's on a merge, and copies it when a category is merged", () => {
    const { db, actor, add, needing, cat } = setup();
    const sewer = add("Utilities", -168.5, { subcategory: "Sewer" });
    cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "Sewer", "never"));
    cats.renameSubcategory(db, actor, { category: "Utilities", from: "Sewer", to: "Sewer district" });
    expect(needing()).toEqual([]);

    const water = add("Utilities", -90, { subcategory: "Water" });
    cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "Water", "always"));
    cats.renameSubcategory(db, actor, { category: "Utilities", from: "Sewer district", to: "Water" });
    // merged into Water, so the Sewer entry now follows Water's "always"
    expect(needing()).toEqual([sewer, water]);

    const svc = ledger.createCategory(db, actor, { name: "Home services", kind: "expense", schedule_e_line: "19" });
    add("Home services", -20, { subcategory: "Window cleaning" });
    cats.setSubcategoryReceiptRule(db, actor, rule("Home services", "Window cleaning", "always"));
    cats.deleteCategoryMoving(db, actor, svc.id, { move_to: "Services" });
    const moved = cats
      .listSubcategories(db)
      .find((x) => x.category_id === cat("Services").id && x.name === "Window cleaning");
    expect(moved?.receipt_policy).toBe("always");
    expect(needing()).toHaveLength(3);
  });

  it("undo puts back the previous subcategory rule", () => {
    const { db, actor, add, needing } = setup();
    const sewer = add("Utilities", -168.5, { subcategory: "Sewer" });
    cats.setSubcategoryReceiptRule(db, actor, rule("Utilities", "Sewer", "never"));
    expect(needing()).toEqual([]);
    const last = db.get<{ id: number }>(
      "SELECT id FROM audit_log WHERE entity = 'subcategory' AND action = 'update' ORDER BY id DESC LIMIT 1" as never,
    )!.id;
    undoAudit(db, actor, last);
    expect(needing()).toEqual([sewer]);
  });
});

describe("vendors that never need a receipt", () => {
  it("skips expenses from a listed vendor in any category, ignoring case, but not by subcategory", () => {
    const { db, actor, add, needing } = setup();
    add("Platform Fees", -120, { vendor: "STRIPE" });
    add("Maintenance", -300, { vendor: " Stripe " });
    const named = add("Utilities", -150, { subcategory: "Stripe" });
    expect(needing()).toHaveLength(3);

    receipts.addReceiptExclusion(db, actor, { name: "stripe" });
    expect(needing()).toEqual([named]);
    expect(receipts.listReceiptExclusions(db).map((x) => [x.name, x.matches])).toEqual([["stripe", 2]]);

    // adding the same name again is a no-op; removing it asks again
    receipts.addReceiptExclusion(db, actor, { name: "STRIPE" });
    expect(receipts.listReceiptExclusions(db)).toHaveLength(1);
    receipts.removeReceiptExclusion(db, actor, "Stripe");
    expect(needing()).toHaveLength(3);
  });

  it("wins over an 'always' rule", () => {
    const { db, actor, add, cat, needing } = setup();
    ledger.updateCategory(db, actor, cat("Platform Fees").id, { receipt_policy: "always" });
    add("Platform Fees", -3, { vendor: "Stripe" });
    receipts.addReceiptExclusion(db, actor, { name: "Stripe" });
    expect(needing()).toEqual([]);
  });

  it("records adds and removes in the audit log", () => {
    const { db, actor } = setup();
    receipts.addReceiptExclusion(db, actor, { name: "Airbnb" });
    receipts.removeReceiptExclusion(db, actor, "airbnb");
    const rows = db.all<{ action: string; entity: string }>(
      "SELECT action, entity FROM audit_log WHERE entity = 'receipt_exclusion' ORDER BY id" as never,
    );
    expect(rows.map((r) => r.action)).toEqual(["create", "delete"]);
  });

  it("undo puts back a removed vendor and a changed category rule", () => {
    const { db, actor, cat } = setup();
    receipts.addReceiptExclusion(db, actor, { name: "Airbnb" });
    receipts.removeReceiptExclusion(db, actor, "Airbnb");
    ledger.updateCategory(db, actor, cat("Supplies").id, { receipt_policy: "always", receipt_min: 10 });
    const last = (entity: string) =>
      db.get<{ id: number }>(
        `SELECT id FROM audit_log WHERE entity = '${entity}' AND action <> 'undo' ORDER BY id DESC LIMIT 1` as never,
      )!.id;
    undoAudit(db, actor, last("receipt_exclusion"));
    expect(receipts.listReceiptExclusions(db).map((x) => x.name)).toEqual(["Airbnb"]);
    undoAudit(db, actor, last("category"));
    expect(cat("Supplies").receipt_policy).toBe("threshold");
    expect(cat("Supplies").receipt_min).toBeNull();
  });
});

describe("one list everywhere", () => {
  it("To do, Files, the tax report and the transactions filter return the same expenses", async () => {
    const { db, actor, add, cat, needing } = setup();
    ledger.updateCategory(db, actor, cat("Supplies").id, { receipt_policy: "always" });
    ledger.updateCategory(db, actor, cat("Cleaning").id, { receipt_min: 200 });
    receipts.addReceiptExclusion(db, actor, { name: "Stripe" });
    cats.setSubcategoryReceiptRule(db, actor, { category: "Utilities", name: "Sewer", receipt_policy: "never" });
    cats.setSubcategoryReceiptRule(db, actor, { category: "Utilities", name: "Water", receipt_policy: "always" });

    const expected = [
      add("Maintenance", -80),
      add("Supplies", -4),
      add("Cleaning", -250),
      add("Utilities", -120, { subcategory: "Electric" }),
      add("Utilities", -12, { subcategory: "Water" }), // subcategory: always
    ];
    add("Mortgage", -2766.37); // line 12: never
    add("Cleaning", -150); // under its $200 threshold
    add("Utilities", -168.5, { subcategory: "Sewer" }); // subcategory: never
    add("Platform Fees", -120, { vendor: "Stripe" }); // never-ask vendor
    add("Maintenance", 300, { refund: true }); // money back
    add("Maintenance", -40); // under $75
    const withReceipt = add("Furnishings", -900);
    await files.addAttachment(db, actor, withReceipt, {
      filename: "r.pdf",
      contentType: "application/pdf",
      data: new TextEncoder().encode("receipt"),
    });
    const trashed = add("Maintenance", -500);
    ledger.deleteTransaction(db, actor, trashed);
    // another year: not in any of the 2026 lists
    ledger.createTransaction(db, actor, { date: "2025-06-01", amount: -500, category: "Maintenance" });

    const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
    const service = sorted(needing().filter((id) => ledger.getTransaction(db, id).date.startsWith("2026")));
    const files2026 = library.listFiles(db, { year: 2026 });
    const tax = reports.taxReport(db, 2026).checks.find((c) => c.code === "missing_receipts");
    const filter = ledger.listTransactions(db, { needs_receipt: "true", year: 2026, limit: 500 });
    const todo = todoSummary(db, { today: "2026-11-16" });

    expect(service).toEqual(sorted(expected));
    expect(sorted(files2026.missing.map((t) => t.id))).toEqual(service);
    expect(files2026.missing_total).toBe(service.length);
    expect(sorted(tax?.ids ?? [])).toEqual(service);
    expect(sorted(filter.items.map((t) => t.id))).toEqual(service);
    expect(todo.missing_receipts).toBe(service.length);
    expect(todo.tax_season).toBe(false);
    // in tax season the count is for last year
    const spring = todoSummary(db, { today: "2027-02-01" });
    expect(spring).toMatchObject({ tax_season: true, receipts_year: 2026, missing_receipts: service.length });
  });
});
