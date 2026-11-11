import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { users, recurringDismissals } = await import("./db/schema.ts");
const ledger = await import("./services/ledger.ts");
const cats = await import("./services/categories.ts");
const { dismiss, seriesKey } = await import("./services/recurring.ts");

function setup() {
  const db = openDb(":memory:");
  seedDefaults(db);
  const user = db.insert(users).values({ email: "t@example.com", role: "admin" }).returning().get();
  const actor = { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  const add = (category: string, subcategory = "", amount = -10) =>
    ledger.createTransaction(db, null, { date: "2026-01-05", amount, category, subcategory });
  const subs = (category: string) =>
    cats
      .listSubcategories(db)
      .filter((s) => s.category_id === ledger.resolveCategory(db, category).id)
      .map((s) => `${s.name}:${s.count}`);
  return { db, actor, add, subs };
}

describe("subcategories", () => {
  it("lists used and saved subcategories and offers saved ones in suggestions", () => {
    const { db, actor, add, subs } = setup();
    add("Utilities", "Electric");
    add("Utilities", "electric");
    add("Utilities", "Gas");
    cats.addSubcategory(db, actor, { category: "Utilities", name: "Water" });
    expect(subs("Utilities")).toEqual(["Electric:2", "Gas:1", "Water:0"]);
    expect(ledger.suggestions(db).subcategories.map((s) => s.subcategory)).toContain("Water");
  });

  it("renames on every transaction, merges into an existing name, and keeps recurring dismissals", () => {
    const { db, actor, add, subs } = setup();
    const a = add("Management Fee", "Acme Mgmt");
    add("Management Fee", "Acme PM");
    add("Cleaning", "Acme Mgmt"); // other category is untouched
    const cat = ledger.resolveCategory(db, "Management Fee").id;
    const oldKey = seriesKey(a.property_id, cat, "", "Acme Mgmt");
    dismiss(db, actor, { series_key: oldKey, month: "2026-02" });

    expect(
      cats.renameSubcategory(db, actor, { category: "Management Fee", from: "acme mgmt", to: "Acme PM" }),
    ).toMatchObject({
      updated: 1,
    });
    expect(subs("Management Fee")).toEqual(["Acme PM:2"]);
    expect(subs("Cleaning")).toEqual(["Acme Mgmt:1"]);
    expect(ledger.getTransaction(db, a.id).subcategory).toBe("Acme PM");
    expect(db.select().from(recurringDismissals).all()[0]!.seriesKey).toBe(
      seriesKey(a.property_id, cat, "", "Acme PM"),
    );
  });

  it("removes a subcategory, clearing or moving its transactions", () => {
    const { db, actor, add, subs } = setup();
    add("Utilities", "Trash");
    add("Utilities", "Sewer");
    add("Utilities", "Old");
    cats.removeSubcategory(db, actor, { category: "Utilities", name: "Trash", move_to: "Sewer" });
    cats.removeSubcategory(db, actor, { category: "Utilities", name: "Old" });
    expect(subs("Utilities")).toEqual(["Sewer:2"]);
    expect(
      ledger
        .listTransactions(db, { category: "Utilities", q: "" })
        .items.map((t) => t.subcategory)
        .sort(),
    ).toEqual(["", "Sewer", "Sewer"]);
  });
});

describe("categories", () => {
  it("deletes a used category only by moving its transactions to one of the same kind", () => {
    const { db, actor, add, subs } = setup();
    add("Platform Fees", "VRBO");
    cats.addSubcategory(db, actor, { category: "Platform Fees", name: "Airbnb" });
    const id = ledger.resolveCategory(db, "Platform Fees").id;
    expect(() => cats.deleteCategoryMoving(db, actor, id)).toThrow(/archive it instead/);
    expect(() => cats.deleteCategoryMoving(db, actor, id, { move_to: "Rental Income" })).toThrow(/income/);
    expect(cats.deleteCategoryMoving(db, actor, id, { move_to: "Services" })).toMatchObject({ moved: 1 });
    expect(ledger.listCategories(db).some((c) => c.name === "Platform Fees")).toBe(false);
    expect(subs("Services")).toEqual(["VRBO:1", "Airbnb:0"]);
  });

  it("renames a category without touching its transactions", () => {
    const { db, actor, add } = setup();
    const t = add("Services");
    const id = ledger.resolveCategory(db, "Services").id;
    ledger.updateCategory(db, actor, id, { name: "Services & Subscriptions" });
    expect(ledger.getTransaction(db, t.id).category).toBe("Services & Subscriptions");
  });
});

describe("undo from the audit log", () => {
  it("reverses edits, deletes and subcategory renames, once", async () => {
    const { db, actor, add, subs } = setup();
    const { undoAudit, annotate } = await import("./services/undo.ts");
    const { listAudit } = await import("./services/audit.ts");
    const last = (action: string, entity: string) =>
      annotate(db, listAudit(db, { limit: 50 })).find((r) => r.action === action && r.entity === entity)!;

    const t = add("Supplies", "", -50);
    ledger.updateTransaction(db, actor, t.id, { amount: -42.5, vendor: "Costco" });
    const edit = last("update", "transaction");
    expect(edit.undo).toMatch(/amount/);
    undoAudit(db, actor, edit.id);
    expect(ledger.getTransaction(db, t.id)).toMatchObject({ amount: -50, vendor: "" });
    expect(() => undoAudit(db, actor, edit.id)).toThrow(/already undone/);
    expect(last("update", "transaction").id).not.toBe(edit.id); // the undo itself was audited

    ledger.deleteTransaction(db, actor, t.id);
    undoAudit(db, actor, last("delete", "transaction").id);
    expect(ledger.getTransaction(db, t.id).amount).toBe(-50);

    add("Utilities", "Gas");
    add("Utilities", "Gas");
    cats.renameSubcategory(db, actor, { category: "Utilities", from: "Gas", to: "Propane" });
    undoAudit(db, actor, last("rename", "subcategory").id);
    expect(subs("Utilities")).toEqual(["Gas:2"]);

    const login = annotate(db, [{ id: 0, action: "login", entity: "user", entity_id: 1, changes: null }])[0]!;
    expect(login.undo).toBeNull();
  });
});
