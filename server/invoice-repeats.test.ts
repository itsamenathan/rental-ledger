import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { users } = await import("./db/schema.ts");
const ledger = await import("./services/ledger.ts");
const ms = await import("./services/manager-statement.ts");
const docs = await import("./services/manager-documents.ts");
const rep = await import("./services/invoice-repeats.ts");
const { todoSummary } = await import("./services/todo.ts");
const { undoAudit } = await import("./services/undo.ts");

// An anonymized copy of a real invoice printed from the browser (names and numbers invented).
const SEPTEMBER = `10/12/26, 9:14 AM Invoice #2061 - Example Rentals
From
Example Rentals
To
Some Owner
Invoice #2061
Issued October 6, 2026
ITEM QUANTITY PRICE TOTAL
Management 1 $3,429.86 $3,429.86
September Cleaning 1 $1,320.00 $1,320.00
Minut 1 $15.00 $15.00
Monitor for noise, parties, excessive occupancy, hot or freezing temps, and humidity.
Deep Clean 1 $540.00 $540.00
Was scheduled in August
Hot tub service (monthly) 1 $400.00 $400.00
includes chemicals, drains/refills as needed, balancing at each checkout
Insurance Waiver Reimbursement 2 $75.00 $150.00
(Paid by guest to owner)
Vrbo Commission Reimbursement 1 $212.89 $212.89
Linens 1 $162.00 $162.00
Queen flat sheet $32
(2) King duvet covers $130
Repairs and Maintenance 1 $383.47 $383.47
Repaired lamp next to bunk bed // installed knob
Light bulbs
Installed hot tub lifter arms
Installed new refrigerator power cord
Installed washing machine door latch
Re-lit upstairs fireplace
Handyman labor and parts $383.47
Subtotal:
Tax:
$6,613.22
$0.00
Total: $6,613.22
Payment received October 9, 2026 $6,613.22`;

const MINUT =
  "Minut 1 $15.00 $15.00\nMonitor for noise, parties, excessive occupancy, hot or freezing temps, and humidity.";
const HOT_TUB =
  "Hot tub service (monthly) 1 $400.00 $400.00\nincludes chemicals, drains/refills as needed, balancing at each checkout";

/** A smaller invoice in the same layout; the total is computed. */
function invoice(number: string, issued: string, rows: string[]) {
  const total = rows.reduce((s, r) => {
    const m = r.split("\n")[0]!.match(/\$([\d,]+\.\d{2})$/);
    return s + Math.round(Number(m![1]!.replace(/,/g, "")) * 100);
  }, 0);
  const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  return [`Invoice #${number}`, `Issued ${issued}`, "ITEM QUANTITY PRICE TOTAL", ...rows, `Total: ${fmt(total)}`].join(
    "\n",
  );
}

const JUNE = invoice("1920", "July 6, 2026", [
  "Management 1 $2,700.00 $2,700.00",
  "June Cleaning 1 $990.00 $990.00",
  MINUT,
  HOT_TUB,
]);
const JULY = invoice("1950", "August 5, 2026", [
  "Management 1 $3,100.00 $3,100.00",
  "July Cleaning 1 $1,250.00 $1,250.00",
  MINUT,
  HOT_TUB,
  "Insurance Waiver Reimbursement 2 $75.00 $150.00\n(Paid by guest to owner)",
  "Vrbo Commission Reimbursement 1 $212.89 $212.89",
  "Linens 1 $130.00 $130.00\n2 x King duvet covers $130",
]);
const AUGUST = invoice("1980", "September 5, 2026", [
  "Management 1 $2,900.00 $2,900.00",
  "August Cleaning 1 $1,100.00 $1,100.00",
  MINUT,
  HOT_TUB,
  "Repairs and Maintenance 1 $210.00 $210.00\nInstalled washing machine door latch\nLight bulbs\nReplaced smoke detector battery",
  "Linens 1 $45.00 $45.00\nQueen flat sheet $30\nBath towels $15",
]);

function setup() {
  const db = openDb(":memory:");
  seedDefaults(db);
  const user = db.insert(users).values({ email: "t@example.com", role: "admin" }).returning().get();
  const actor = { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  const save = async (month: string, text: string, property?: number) => {
    const [r] = await docs.saveDocuments(
      db,
      actor,
      [{ filename: `${month}.txt`, contentType: "text/plain", data: new TextEncoder().encode(text) }],
      { month, property },
    );
    expect(r!.status).toBe("saved");
  };
  const review = (month: string, property?: number) => ms.previewManagerMonth(db, { month, property_id: property });
  const repeats = (month: string, property?: number) =>
    review(month, property)
      .checks.filter((c) => c.phrase)
      .map((c) => c.text);
  return { db, actor, save, review, repeats };
}

describe("normalizePhrase", () => {
  it.each([
    ["September Cleaning", "cleaning"],
    ["Cleaning - Sept. 2026", "cleaning"],
    ["Cleaning (Dec 2025)", "cleaning"],
    ["Repaired gate 8/14", "repaired gate"],
    ["(2) King duvet covers", "king duvet covers"],
    ["2 x King duvet covers", "king duvet covers"],
    ["2x light bulbs", "light bulbs"],
    ["Re-lit upstairs fireplace", "re lit upstairs fireplace"],
    ["  Light   Bulbs. ", "light bulbs"],
    // a plain leading number isn't reliably a count
    ["2nd floor smoke detector", "2nd floor smoke detector"],
    ["3 bulbs", "3 bulbs"],
    // only a leading "(n)" is a count; other parentheses stay
    ["(Paid by guest to owner)", "paid by guest to owner"],
  ])("%s → %s", (raw, out) => {
    expect(rep.normalizePhrase(raw)).toBe(out);
  });
});

describe("invoice parsing", () => {
  it("parses the browser-printed invoice into detail sub-items", () => {
    const inv = ms.parseInvoiceText(SEPTEMBER);
    expect(inv).toMatchObject({ number: "2061", total: 6613.22, warnings: [] });
    const by = Object.fromEntries(inv.lines.map((l) => [l.item, l]));
    expect(by.Linens!.description).toBe("Queen flat sheet $32; (2) King duvet covers $130");
    expect(by["Repairs and Maintenance"]!.description).toBe(
      "Repaired lamp next to bunk bed // installed knob; Light bulbs; Installed hot tub lifter arms; Installed new refrigerator power cord; Installed washing machine door latch; Re-lit upstairs fireplace",
    );
    expect(by["Insurance Waiver Reimbursement"]).toMatchObject({ quantity: 2, amount: 150 });
  });

  it("tells the user to print from the browser when a different layout can't be read", () => {
    const portal = "Invoice #2061\nITEM\nQTY\nPrice\nTotal\nManagement\n1\n$3,429.86\n$3,429.86\nTotal: $3,429.86";
    expect(() => ms.parseInvoiceText(portal)).toThrow(/Couldn't find any invoice line items.*print it to PDF/);
  });
});

describe("cross-month repeats", () => {
  it("flags repeated repairs and priced items; recurring services, waivers and Deep Clean stay quiet", async () => {
    const { save, repeats } = setup();
    for (const [m, t] of [
      ["2026-06", JUNE],
      ["2026-07", JULY],
      ["2026-08", AUGUST],
      ["2026-09", SEPTEMBER],
    ] as const)
      await save(m, t);
    expect(repeats("2026-09")).toEqual([
      "(2) King duvet covers $130 was also billed on the July invoice (#1950)",
      "Light bulbs was also billed on the August invoice (#1980)",
      "Installed washing machine door latch was also billed on the August invoice (#1980)",
    ]);
    // Minut and the hot tub are on four months' invoices by now; June → August is three, so August is quiet too.
    expect(repeats("2026-08")).toEqual([]);
    // Only two months of Minut / hot tub up to July: not recurring yet.
    expect(repeats("2026-07")).toEqual([
      "Monitor for noise, parties, excessive occupancy, hot or freezing temps, and humidity. was also billed on the June invoice (#1920)",
      "includes chemicals, drains/refills as needed, balancing at each checkout was also billed on the June invoice (#1920)",
    ]);
  });

  it("matches a priced sub-item only when the price matches too", () => {
    const mk = (month: string, number: string, description: string) => ({
      month,
      number,
      issued: null,
      documentId: null,
      lines: [{ item: "Linens", description, quantity: 1, amount: 50 }],
    });
    const run = (earlier: string, now: string) =>
      rep.findInvoiceRepeats({
        month: "2026-09",
        current: [mk("2026-09", "2", now)],
        saved: [mk("2026-08", "1", earlier)],
        dismissed: new Set(),
      }).warnings;
    expect(run("Queen flat sheet $32", "Queen flat sheet $32.00")).toHaveLength(1);
    expect(run("Queen flat sheet $30", "Queen flat sheet $32")).toEqual([]);
    expect(run("Queen flat sheet", "Queen flat sheet $32")).toEqual([]);
  });

  it("compares lines without detail by item + amount, and ignores a line total that differs", () => {
    const line = (item: string, amount: number) => ({ item, description: "", quantity: 1, amount });
    const run = (a: number, b: number) =>
      rep.findInvoiceRepeats({
        month: "2026-09",
        current: [{ month: "2026-09", number: "2", issued: null, documentId: null, lines: [line("Propane Tank", b)] }],
        saved: [{ month: "2026-08", number: "1", issued: null, documentId: null, lines: [line("Propane tank", a)] }],
        dismissed: new Set(),
      }).warnings;
    expect(run(50, 50).map((w) => w.text)).toEqual([
      '"Propane Tank" ($50.00) was also billed on the August invoice (#1)',
    ]);
    expect(run(50, 55)).toEqual([]);
  });

  it("follows 'Was scheduled in August' to August's invoice, and says nothing when August didn't bill it", async () => {
    const quiet = setup();
    await quiet.save("2026-08", AUGUST);
    await quiet.save("2026-09", SEPTEMBER);
    expect(quiet.repeats("2026-09").filter((t) => /Deep Clean/.test(t))).toEqual([]);

    const billed = setup();
    await billed.save("2026-08", invoice("1980", "September 5, 2026", ["Deep clean 1 $540.00 $540.00"]));
    await billed.save("2026-09", SEPTEMBER);
    expect(billed.repeats("2026-09").filter((t) => /Deep Clean/.test(t))).toEqual([
      '"Deep Clean" ($540.00) says "Was scheduled in August"; the August invoice (#1980) already billed "Deep clean" ($540.00)',
    ]);
  });

  it("flags the later month when invoices are saved out of order, and later invoices never change an earlier month", async () => {
    const { save, repeats } = setup();
    const repair = (n: string, issued: string) =>
      invoice(n, issued, ["Repairs 1 $80.00 $80.00\nInstalled washing machine door latch\nFixed gate"]);
    await save("2026-09", repair("2061", "October 6, 2026"));
    expect(repeats("2026-09")).toEqual([]);
    await save("2026-08", repair("1980", "September 5, 2026"));
    expect(repeats("2026-08")).toEqual([]);
    const sep = repeats("2026-09");
    expect(sep).toContain("Installed washing machine door latch was also billed on the August invoice (#1980)");
    // A third month makes the phrase recurring from October on, but September's warning stays.
    await save("2026-10", repair("2090", "November 5, 2026"));
    expect(repeats("2026-10")).toEqual([]);
    expect(repeats("2026-09")).toEqual(sep);
  });

  it("compares two invoices of the same month in issue order, and never an invoice with its own saved copy", async () => {
    const { db, save, repeats } = setup();
    await save("2026-09", invoice("2061", "October 6, 2026", ["Repairs 1 $80.00 $80.00\nReplaced porch light"]));
    await save("2026-09", invoice("2062", "October 20, 2026", ["Repairs 1 $95.00 $95.00\nReplaced porch light"]));
    expect(repeats("2026-09")).toEqual([
      "Invoice 2062: Replaced porch light was also billed on the September invoice (#2061)",
    ]);
    // The same invoice passed in directly (MCP / API) isn't compared with its saved self.
    const direct = ms.previewManagerMonth(db, {
      month: "2026-09",
      invoice_text: invoice("2061", "October 6, 2026", ["Repairs 1 $80.00 $80.00\nReplaced porch light"]),
    });
    expect(direct.checks.filter((c) => c.phrase)).toEqual([]);
  });

  it("still keeps equal-amount lines in one month apart", () => {
    const { db } = setup();
    const p = ms.previewManagerMonth(db, {
      month: "2026-09",
      invoice_text: invoice("1", "October 6, 2026", ["Propane Tank 1 $50.00 $50.00", "Dump run 1 $50.00 $50.00"]),
    });
    expect(p.lines.map((l) => l.status)).toEqual(["missing", "missing"]);
    expect(p.checks.filter((c) => c.phrase)).toEqual([]);
  });
});

describe("explained, 'this recurs' and the To do count", () => {
  it("counts repeats as things to check until explained or marked recurring", async () => {
    const { db, actor, save, review } = setup();
    for (const [m, t] of [
      ["2026-06", JUNE],
      ["2026-07", JULY],
      ["2026-08", AUGUST],
      ["2026-09", SEPTEMBER],
    ] as const)
      await save(m, t);
    const sepTodo = () => todoSummary(db).manager_months.find((m) => m.month === "2026-09")!.to_check;
    const before = sepTodo();
    const flagged = review("2026-09").checks.filter((c) => c.phrase);
    expect(flagged.map((c) => c.phrase)).toEqual([
      "king duvet covers",
      "light bulbs",
      "installed washing machine door latch",
    ]);
    expect(flagged.every((c) => c.level === "warn" && c.key)).toBe(true);

    // "This recurs" for light bulbs
    const d = rep.dismissRepeat(db, actor, { phrase: "Light bulbs" });
    expect(d.phrase).toBe("light bulbs");
    expect(sepTodo()).toBe(before - 1);
    const after = review("2026-09");
    expect(after.checks.filter((c) => c.phrase).map((c) => c.phrase)).toEqual([
      "king duvet covers",
      "installed washing machine door latch",
    ]);
    expect(after.repeat_dismissals).toEqual([{ id: d.id, phrase: "light bulbs" }]);

    // "Explained" for the door latch, through the existing acknowledgement
    ms.acknowledgeCheck(db, actor, { month: "2026-09", key: flagged[2]!.key!, note: "Second latch broke" });
    expect(sepTodo()).toBe(before - 2);
    expect(review("2026-09").checks.find((c) => c.phrase === "installed washing machine door latch")).toMatchObject({
      level: "info",
      explained: { note: "Second latch broke" },
    });

    // Flag again, then undo that through the audit log
    rep.undismissRepeat(db, actor, d.id);
    expect(sepTodo()).toBe(before - 1);
    expect(rep.listRepeatDismissals(db)).toEqual([]);
  });

  it("lists a month whose only open item is a repeat on To do, until it's marked recurring", async () => {
    const { db, actor, save, review } = setup();
    for (const [m, n, issued] of [
      ["2026-08", "1980", "September 5, 2026"],
      ["2026-09", "2061", "October 6, 2026"],
    ] as const) {
      await save(m, invoice(n, issued, ["Repairs 1 $80.00 $80.00\nFixed porch gate"]));
      ledger.createTransaction(db, null, { date: `${m}-30`, amount: -80, category: "Maintenance" });
      for (const c of review(m).checks.filter((x) => x.key && /No owner statement/.test(x.text)))
        ms.acknowledgeCheck(db, actor, { month: m, key: c.key! });
    }
    const before = todoSummary(db);
    expect(before.manager_months).toEqual([{ property_id: 1, month: "2026-09", to_add: 0, to_check: 1 }]);
    rep.dismissRepeat(db, actor, { phrase: "Fixed porch gate" });
    expect(todoSummary(db).manager_months).toEqual([]);
    expect(todoSummary(db).total).toBe(before.total - 1);
  });

  it("keeps a 'this recurs' phrase to its own property", async () => {
    const { db, actor, save, repeats } = setup();
    const harbor = ledger.createProperty(db, null, { name: "Harbor" });
    const cabin = ledger.createProperty(db, null, { name: "Cabin" });
    for (const p of [harbor.id, cabin.id]) {
      await save("2026-08", AUGUST, p);
      await save("2026-09", SEPTEMBER, p);
    }
    rep.dismissRepeat(db, actor, { property_id: harbor.id, phrase: "light bulbs", note: "We buy these monthly" });
    expect(repeats("2026-09", harbor.id).some((t) => t.startsWith("Light bulbs"))).toBe(false);
    expect(repeats("2026-09", cabin.id).some((t) => t.startsWith("Light bulbs"))).toBe(true);
    expect(rep.listRepeatDismissals(db, { property: cabin.id })).toEqual([]);
    expect(rep.listRepeatDismissals(db, { property: harbor.id })).toMatchObject([
      { phrase: "light bulbs", note: "We buy these monthly", property_id: harbor.id },
    ]);
    expect(() => rep.dismissRepeat(db, actor, { phrase: "light bulbs" })).toThrow(); // two properties: no guessing
  });

  it("can undo a 'this recurs' from the audit log", async () => {
    const { db, actor, save, repeats } = setup();
    await save("2026-08", AUGUST);
    await save("2026-09", SEPTEMBER);
    rep.dismissRepeat(db, actor, { phrase: "light bulbs" });
    const { auditLog } = await import("./db/schema.ts");
    const { desc } = await import("drizzle-orm");
    const entry = db.select().from(auditLog).orderBy(desc(auditLog.id)).get()!;
    expect(entry.entity).toBe("invoice_repeat_dismissal");
    undoAudit(db, actor, entry.id);
    expect(repeats("2026-09").some((t) => t.startsWith("Light bulbs"))).toBe(true);
  });
});
