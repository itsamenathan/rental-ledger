import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
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
  seedDefaults(db);
  const user = db.insert(users).values({ email: "t@example.com", role: "admin" }).returning().get();
  const actor = { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  const add = (category: string, amount: number, extra: Record<string, unknown> = {}) =>
    ledger.createTransaction(db, actor, { date: "2026-06-15", amount, category, ...extra }).id;
  const cat = (name: string) => ledger.resolveCategory(db, name);
  const needing = () => receipts.missingReceiptIds(db);
  return { db, actor, add, cat, needing };
}

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

describe("never-ask names", () => {
  it("skips expenses whose vendor or subcategory matches, in any category, ignoring case", () => {
    const { db, actor, add, needing } = setup();
    add("Utilities", -168.5, { subcategory: "Sewer" });
    add("Platform Fees", -120, { vendor: "STRIPE" });
    add("Maintenance", -300, { vendor: "Stripe", subcategory: "Wolfman" });
    const electric = add("Utilities", -150, { subcategory: "Electric" });
    expect(needing()).toHaveLength(4);

    receipts.addReceiptExclusion(db, actor, { name: "sewer" });
    receipts.addReceiptExclusion(db, actor, { name: " Stripe " });
    expect(needing()).toEqual([electric]);
    expect(receipts.listReceiptExclusions(db).map((x) => [x.name, x.matches])).toEqual([
      ["sewer", 1],
      ["Stripe", 2],
    ]);

    // adding the same name again is a no-op; removing it asks again
    receipts.addReceiptExclusion(db, actor, { name: "SEWER" });
    expect(receipts.listReceiptExclusions(db)).toHaveLength(2);
    receipts.removeReceiptExclusion(db, actor, "Sewer");
    expect(needing()).toHaveLength(2);
  });

  it("follows a subcategory rename, unless the old name is still used elsewhere", () => {
    const { db, actor, add, needing } = setup();
    add("Utilities", -168.5, { subcategory: "Sewer" });
    receipts.addReceiptExclusion(db, actor, { name: "Sewer" });
    cats.renameSubcategory(db, actor, { category: "Utilities", from: "Sewer", to: "Sewer district" });
    expect(receipts.listReceiptExclusions(db).map((x) => x.name)).toEqual(["Sewer district"]);
    expect(needing()).toEqual([]);

    add("Services", -90, { subcategory: "Trash" });
    add("Utilities", -90, { subcategory: "Trash" });
    receipts.addReceiptExclusion(db, actor, { name: "Trash" });
    cats.renameSubcategory(db, actor, { category: "Utilities", from: "Trash", to: "Garbage" });
    expect(receipts.listReceiptExclusions(db).map((x) => x.name)).toEqual(["Sewer district", "Trash"]);
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

  it("undo puts back a removed name and a changed category rule", () => {
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
    receipts.addReceiptExclusion(db, actor, { name: "Sewer" });

    const expected = [
      add("Maintenance", -80),
      add("Supplies", -4),
      add("Cleaning", -250),
      add("Utilities", -120, { subcategory: "Electric" }),
    ];
    add("Mortgage", -2766.37); // line 12: never
    add("Cleaning", -150); // under its $200 threshold
    add("Utilities", -168.5, { subcategory: "Sewer" }); // never-ask name
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
  });
});
