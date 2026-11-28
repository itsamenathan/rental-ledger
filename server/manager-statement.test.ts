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
const ms = await import("./services/manager-statement.ts");
const docs = await import("./services/manager-documents.ts");

// All names, ids and amounts below are invented.
const HEADER =
  'Listing,Guest,Channel,"Check-in date","Check-out date",AcmeOwnerPayout,AcmeCleaningFee,AcmeManagementFee,"Vrbo Commission",AcmeRent,"Host channel fee","Cancellation payout",Nights,"Reservation ID","Resort fee Airbnb"';
const csv = (...rows: string[]) => [HEADER, ...rows, ",,,,,,,,,,,,,,", "TOTALS,,,,,,,,,,,,,,"].join("\n");
const row = (
  guest: string,
  ch: string,
  ci: string,
  co: string,
  payout: string,
  id: string,
  commission = "$0.00",
  cancel = "$0.00",
) =>
  `"Cabin","${guest}",${ch},${ci},${co},"${payout}",$100.00,$30.00,${commission},$300.00,$20.00,${cancel},3,${id},$0.00`;

const STATEMENT = csv(
  row("Guest A", "airbnbOfficial", "2026-10-02", "2026-10-05", "$1,000.50", "R1"),
  row("Guest B", "airbnbOfficial", "2026-10-10", "2026-10-12", "$400.00", "R2"),
);

const INVOICE_TEXT = [
  "From\nAcme Rentals\nTo\nSome Owner\nInvoice 77\nIssued November 6, 2026\nDue Date November 22, 2026",
  "ITEM QUANTITY PRICE TOTAL",
  "Management 1 $90.00 $90.00",
  "Cleaning 2 $50.00 $100.00",
  "Minut 2 $15.00 $30.00\nNoise metering",
  "Propane Tank 1 $50.00 $50.00",
  "Repairs 1 $40.00 $40.00\nFixed the gate\nHandyman and parts $40.00\nCabin Homes: $400.00\n11/15/26, 8:58 AM Invoice #77 - Acme",
  "Dump run 1 $50.00 $50.00\nDump fee",
  "Subtotal:\nTax:\n$360.00\n$0.00\nTotal: $360.00\nPending payment received November 10, 2026 $360.00\nPayment received November 11, 2026 $360.00",
].join("\n");

function setup(opts: { history?: boolean } = {}) {
  const db = openDb(":memory:");
  seedDefaults(db, TEST_CATEGORIES);
  const user = db.insert(users).values({ email: "t@example.com", role: "admin" }).returning().get();
  const actor = { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  if (opts.history)
    ledger.createTransaction(db, null, {
      date: "2026-09-30",
      amount: -80,
      category: "Management Fee",
      subcategory: "Acme",
    });
  return { db, actor };
}

describe("statement CSV", () => {
  it("matches columns by suffix, skips total rows and keeps cents exact", () => {
    const s = ms.parseStatementCsv(STATEMENT);
    expect(s.reservations.map((r) => [r.reservation_id, r.payout, r.check_out])).toEqual([
      ["R1", 1000.5, "2026-10-05"],
      ["R2", 400, "2026-10-12"],
    ]);
    expect(s.totals).toMatchObject({ payout: 1400.5, management_fee: 60, cleaning_fee: 200, channel_fee: 40 });
    expect(s.warnings).toEqual([]);
  });

  it("warns about money in columns it doesn't model and rejects other CSVs", () => {
    const s = ms.parseStatementCsv(
      csv(row("G", "vrbo", "2026-10-02", "2026-10-05", "$10.00", "R9", "$12.34", "$50.00")),
    );
    expect(s.reservations[0]!.commission).toBe(12.34); // modeled: billed back on the invoice
    expect(s.warnings).toEqual([
      'Reservation R9: amounts in columns that aren\'t modeled: "Cancellation payout" $50.00',
    ]);
    expect(s.reservations[0]!.cancelled).toBe(false); // still has rent: a stay with a partial refund
    const cancelled = ms.parseStatementCsv(
      csv(row("G", "vrbo", "2026-10-02", "2026-10-05", "$50.00", "R9", "$0.00", "$50.00").replace("$300.00", "$0.00")),
    );
    expect(cancelled.reservations[0]!.cancelled).toBe(true);
    expect(() => ms.parseStatementCsv("a,b\n1,2")).toThrow(/missing column/);
  });
});

describe("invoice text", () => {
  it("parses items across pages, drops banners/footers/summary lines and verifies the total", () => {
    const inv = ms.parseInvoiceText(INVOICE_TEXT);
    expect(inv).toMatchObject({ number: "77", issued: "2026-11-06", paid: "2026-11-11", total: 360 });
    expect(inv.lines.map((l) => [l.item, l.quantity, l.amount])).toEqual([
      ["Management", 1, 90],
      ["Cleaning", 2, 100],
      ["Minut", 2, 30],
      ["Propane Tank", 1, 50],
      ["Repairs", 1, 40],
      ["Dump run", 1, 50],
    ]);
    expect(inv.lines[2]!.description).toBe("Noise metering");
    expect(inv.lines[4]!.description).toBe("Fixed the gate");
    expect(inv.warnings).toEqual([]);
  });

  it("warns when the lines don't add up", () => {
    const inv = ms.parseInvoiceText(INVOICE_TEXT.replace("Total: $360.00", "Total: $999.00"));
    expect(inv.warnings?.join()).toContain("add up to $360.00 but the invoice total is $999.00");
  });
});

describe("reconcile + apply", () => {
  it("proposes everything on an empty ledger, including two equal-amount lines", () => {
    const { db } = setup({ history: true });
    const p = ms.previewManagerMonth(db, { statement_csv: STATEMENT, invoice_text: INVOICE_TEXT });
    expect(p.month).toBe("2026-10");
    expect(p.subcategory).toBe("Acme");
    expect(p.summary).toMatchObject({ income_missing: 2, lines_missing: 6 });
    const cats = Object.fromEntries(p.lines.map((l) => [l.item, l.category]));
    expect(cats).toMatchObject({
      Management: "Management Fee",
      Cleaning: "Cleaning",
      Minut: "Services",
      "Propane Tank": "Supplies",
      Repairs: "Maintenance",
      "Dump run": "Maintenance",
    });
    // Propane and the dump run are both $50 on the same day; neither may swallow the other.
    expect(p.lines.filter((l) => l.amount === 50).map((l) => l.status)).toEqual(["missing", "missing"]);
  });

  it("creates what is missing once, never duplicates on re-apply, and leaves reference/external_id alone", () => {
    const { db, actor } = setup({ history: true });
    const grist = ledger.createTransaction(db, null, {
      date: "2026-10-04",
      amount: 1000.5,
      category: "Rental Income",
      external_id: "grist:doc:1",
    });
    const input = { statement_csv: STATEMENT, invoice_text: INVOICE_TEXT };
    const p = ms.previewManagerMonth(db, input);
    expect(p.income.map((i) => [i.reservation_id, i.status, i.transaction_id])).toEqual([
      ["R1", "matched", grist.id],
      ["R2", "missing", undefined],
    ]);

    const res = ms.applyManagerMonth(db, actor, {
      ...input,
      create_income: ["R2"],
      create_lines: p.lines.map((l) => l.index),
    });
    expect(res.created_expenses).toHaveLength(6);
    expect(res.created_income).toHaveLength(1);
    expect(res.tagged).toEqual([grist.id]);
    expect(res.anchor_transaction_id).toBe(res.created_expenses[0]);
    expect(res.invoice_transaction_ids).toEqual(res.created_expenses);

    const tagged = ledger.getTransaction(db, grist.id);
    expect(tagged.description).toBe("Reservation R1 (check-in 2026-10-02)");
    expect(tagged.external_id).toBe("grist:doc:1");
    expect(tagged.reference).toBe("");

    const expenses = ledger.listTransactions(db, { month: "2026-10", kind: "expense" }).items;
    expect(expenses).toHaveLength(6);
    expect(
      expenses.every((e) => e.date === "2026-10-31" && e.subcategory === "Acme" && e.reference === "Invoice 77"),
    ).toBe(true);
    expect(expenses.reduce((s, e) => s + e.amount, 0)).toBeCloseTo(-360);
    const created = ledger.getTransaction(db, res.created_income[0]!);
    expect(created).toMatchObject({ amount: 400, date: "2026-10-12", needs_review: true, vendor: "Airbnb" });

    const again = ms.previewManagerMonth(db, input);
    expect(again.summary).toMatchObject({ income_missing: 0, lines_missing: 0 });
    const second = ms.applyManagerMonth(db, actor, {
      ...input,
      create_income: ["R2"],
      create_lines: [0, 1, 2, 3, 4, 5],
    });
    expect(second.created_expenses).toEqual([]);
    expect(second.created_income).toEqual([]);
    expect(ledger.listTransactions(db, { month: "2026-10" }).total).toBe(1 + 1 + 6); // the history row is in September
  });

  it("matches existing lines loosely when the ledger used a different category, and never overwrites a description", () => {
    const { db, actor } = setup({ history: true });
    const mgmt = ledger.createTransaction(db, null, {
      date: "2026-10-31",
      amount: -90,
      category: "Management Fee",
      subcategory: "Acme",
    });
    const hot = ledger.createTransaction(db, null, {
      date: "2026-10-31",
      amount: -50,
      category: "Supplies", // dump run entered under another category
      subcategory: "Acme",
    });
    const written = ledger.createTransaction(db, null, {
      date: "2026-10-03",
      amount: 1000.5,
      category: "Rental Income",
      description: "my own note",
    });
    const p = ms.previewManagerMonth(db, { statement_csv: STATEMENT, invoice_text: INVOICE_TEXT });
    expect(p.lines.find((l) => l.item === "Management")).toMatchObject({ status: "exists", transaction_id: mgmt.id });
    const exists50 = p.lines.filter((l) => l.amount === 50);
    expect(exists50.map((l) => l.status).sort()).toEqual(["exists", "missing"]);
    expect(exists50.find((l) => l.status === "exists")!.transaction_id).toBe(hot.id);

    ms.applyManagerMonth(db, actor, { statement_csv: STATEMENT, invoice_text: INVOICE_TEXT });
    expect(ledger.getTransaction(db, written.id).description).toBe("my own note");
  });

  it("doesn't loose-match unrelated purchases when there is no manager subcategory", () => {
    const { db } = setup(); // no history: no subcategory can be inferred
    ledger.createTransaction(db, null, { date: "2026-10-12", amount: -30, category: "Supplies" });
    const text = "Minut 2 $15.00 $30.00\nTotal: $30.00";
    const p = ms.previewManagerMonth(db, { invoice_text: text, month: "2026-10" });
    expect(p.subcategory).toBe("");
    expect(p.lines[0]).toMatchObject({ category: "Services", status: "missing" });
  });

  it("matches a VRBO payout paid as a ~30% deposit plus the balance, and checks fees billed back", () => {
    const { db, actor } = setup();
    const add = (date: string, amount: number) =>
      ledger.createTransaction(db, null, { date, amount, category: "Rental Income" });
    const deposit = add("2026-06-03", 300.15); // 30% shortly after booking, months before the stay
    const balance = add("2026-09-20", 700.35);
    add("2026-10-07", 250); // unrelated
    const statement = csv(row("G", "vrbo", "2026-10-02", "2026-10-05", "$1,000.50", "V1", "$40.00"));
    const invoice = "Management 1 $30.00 $30.00\nVrbo Commission Reimbursement 1 $40.00 $40.00\nTotal: $70.00";
    const p = ms.previewManagerMonth(db, { statement_csv: statement, invoice_text: invoice });
    expect(p.income[0]).toMatchObject({ status: "matched", transactions: [{ id: deposit.id }, { id: balance.id }] });
    expect(p.checks).toContainEqual({ level: "ok", text: "VRBO commission matches: $40.00 on both" });
    expect(p.unlisted_income.map((u) => u.amount)).toEqual([250]);

    const res = ms.applyManagerMonth(db, actor, { statement_csv: statement, invoice_text: invoice });
    expect(res.tagged).toEqual([deposit.id, balance.id]);
    expect(ledger.getTransaction(db, balance.id).description).toBe("Reservation V1 (check-in 2026-10-02, balance)");
  });

  it("reports a payout recorded with a different amount, and never offers to add a Stripe-paid payout", () => {
    const { db } = setup();
    ledger.createTransaction(db, null, { date: "2026-10-04", amount: 800.5, category: "Rental Income" });
    const p = ms.previewManagerMonth(db, {
      statement_csv: csv(
        row("A", "airbnbOfficial", "2026-10-02", "2026-10-05", "$1,000.50", "R1"),
        row("B", "vrbo", "2026-10-10", "2026-10-12", "$400.00", "V2"),
      ),
    });
    expect(p.income[0]).toMatchObject({ status: "differs", difference: -200 });
    expect(p.income[1]).toMatchObject({ status: "batched" });
    expect(p.summary.income_missing).toBe(0);
    const warns = p.checks.filter((c) => c.level === "warn" && !c.code).map((c) => c.text);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("The Oct 2 stay (#R1) is $1,000.50 on the statement but $800.50 was deposited (Oct 4)");
    expect(
      p.checks.find((c) => c.level === "info" && c.text.startsWith("A VRBO payout ($400.00) couldn't be tied")),
    ).toBeTruthy();
  });

  it("keeps a different-amount payout flagged after apply, even if someone tagged it", () => {
    const { db, actor } = setup();
    const row1 = ledger.createTransaction(db, null, { date: "2026-10-04", amount: 800.5, category: "Rental Income" });
    const statement = csv(row("A", "airbnbOfficial", "2026-10-02", "2026-10-05", "$1,000.50", "R1"));
    ms.applyManagerMonth(db, actor, { statement_csv: statement });
    expect(ledger.getTransaction(db, row1.id).description).toBe(""); // not tagged
    ledger.updateTransaction(db, actor, row1.id, { description: "Reservation R1" }); // tagged by hand
    const p = ms.previewManagerMonth(db, { statement_csv: statement });
    expect(p.income[0]).toMatchObject({ status: "differs", difference: -200 });
  });

  it("gives a deposit to the stay on whichever saved statement it matches exactly, whatever month is viewed", async () => {
    const { db, actor } = setup();
    const save = (name: string, body: string) =>
      docs.saveDocuments(db, actor, [
        { filename: name, contentType: "text/csv", data: new TextEncoder().encode(body) },
      ]);
    // August's last stay is paid Sep 1; September's first stay checks in that day for a similar amount.
    await save("aug.csv", csv(row("A", "airbnbOfficial", "2026-08-28", "2026-08-31", "$1,291.86", "AUG1")));
    await save("sep.csv", csv(row("B", "airbnbOfficial", "2026-09-01", "2026-09-04", "$1,371.70", "SEP1")));
    const dep = ledger.createTransaction(db, null, { date: "2026-09-01", amount: 1291.86, category: "Rental Income" });

    const sep = ms.previewManagerMonth(db, { month: "2026-09" });
    expect(sep.income[0]).toMatchObject({ reservation_id: "SEP1", status: "missing" }); // not "differs"
    expect(sep.unlisted_income).toEqual([]); // explained by August's statement
    const aug = ms.previewManagerMonth(db, { month: "2026-08" });
    expect(aug.income[0]).toMatchObject({ reservation_id: "AUG1", status: "matched", transaction_id: dep.id });

    const year = ms.managerYear(db, { year: 2026 });
    expect(year.months.filter((m) => m.status !== "empty").map((m) => [m.month, m.status])).toEqual([
      ["2026-08", "check"], // no invoice saved yet
      ["2026-09", "todo"],
    ]);
  });

  it("lists unexplained months as a to-do until the difference is marked as explained", async () => {
    const { db, actor } = setup();
    const { todoSummary } = await import("./services/todo.ts");
    await docs.saveDocuments(db, actor, [
      {
        filename: "oct.csv",
        contentType: "text/csv",
        data: new TextEncoder().encode(csv(row("A", "airbnbOfficial", "2026-10-02", "2026-10-05", "$1,000.50", "R1"))),
      },
    ]);
    ledger.createTransaction(db, null, { date: "2026-10-04", amount: 800.5, category: "Rental Income" });
    const before = todoSummary(db);
    expect(before.manager_months).toEqual([{ property_id: 1, month: "2026-10", to_add: 0, to_check: 2 }]); // + no invoice
    const p = ms.previewManagerMonth(db, { month: "2026-10" });
    for (const c of p.checks.filter((c) => c.level === "warn" && !c.code))
      ms.acknowledgeCheck(db, actor, { month: "2026-10", key: c.key!, note: "Guest refund, confirmed" });
    const after = ms.previewManagerMonth(db, { month: "2026-10" });
    expect(after.summary.to_check).toBe(0);
    expect(after.checks.find((c) => c.text.includes("#R1"))).toMatchObject({
      level: "info",
      explained: { note: "Guest refund, confirmed" },
    });
    expect(todoSummary(db).manager_months).toEqual([]);
    expect(todoSummary(db).total).toBe(before.total - 1);
    ms.unacknowledgeCheck(db, actor, { month: "2026-10", key: after.checks.find((c) => c.text.includes("#R1"))!.key! });
    expect(ms.previewManagerMonth(db, { month: "2026-10" }).summary.to_check).toBe(1);
  });

  it("reads the month from a mid-month invoice", () => {
    const { db } = setup();
    const text = (issued: string) => `Invoice 5\nIssued ${issued}\nCleaning 1 $10.00 $10.00\nTotal: $10.00`;
    expect(ms.previewManagerMonth(db, { invoice_text: text("September 19, 2026") }).month).toBe("2026-09");
    expect(ms.previewManagerMonth(db, { invoice_text: text("November 6, 2026") }).month).toBe("2026-10");
  });

  it("needs a category for lines it can't classify, and refuses read-only actors", () => {
    const { db, actor } = setup();
    const text = "Widget polishing 1 $25.00 $25.00\nTotal: $25.00";
    const p = ms.previewManagerMonth(db, { invoice_text: text, month: "2026-10" });
    expect(p.lines[0]!.status).toBe("uncategorized");
    expect(() => ms.applyManagerMonth(db, actor, { invoice_text: text, month: "2026-10", create_lines: [0] })).toThrow(
      /needs a category/,
    );
    const done = ms.applyManagerMonth(db, actor, {
      invoice_text: text,
      month: "2026-10",
      create_lines: [0],
      overrides: { "0": { category: "Services" } },
    });
    expect(done.created_expenses).toHaveLength(1);
    expect(() =>
      ms.applyManagerMonth(db, { ...actor, canWrite: false }, { invoice_text: text, month: "2026-10" }),
    ).toThrow();
  });
});
