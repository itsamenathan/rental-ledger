import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { users } = await import("./db/schema.ts");
const ledger = await import("./services/ledger.ts");
const imp = await import("./services/csv-import.ts");
const { undoAudit } = await import("./services/undo.ts");
const { listAudit } = await import("./services/audit.ts");

function setup() {
  const db = openDb(":memory:");
  seedDefaults(db);
  const user = db.insert(users).values({ email: "t@example.com", role: "admin" }).returning().get();
  const actor = { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  const add = (date: string, amount: number, category: string, extra: Record<string, unknown> = {}) =>
    ledger.createTransaction(db, null, { date, amount, category, ...extra });
  return { db, actor, add };
}

describe("parsing", () => {
  it("reads dates in common export formats", () => {
    expect(imp.parseImportDate("2026-03-04")).toBe("2026-03-04");
    expect(imp.parseImportDate("2026/3/4 12:00")).toBe("2026-03-04");
    expect(imp.parseImportDate("20260304")).toBe("2026-03-04");
    expect(imp.parseImportDate("03/04/2026", "MDY")).toBe("2026-03-04");
    expect(imp.parseImportDate("03/04/2026", "DMY")).toBe("2026-04-03");
    expect(imp.parseImportDate("3/4/26")).toBe("2026-03-04");
    expect(imp.parseImportDate("04-Mar-2026")).toBe("2026-03-04");
    expect(imp.parseImportDate("Mar 4, 2026")).toBe("2026-03-04");
    expect(imp.parseImportDate("02/30/2026")).toBeNull();
    expect(imp.detectDateFormat(["03/04/2026", "25/04/2026"])).toBe("DMY");
    expect(imp.detectDateFormat(["2026-01-02"])).toBe("YMD");
  });

  it("reads amounts with symbols, parentheses, trailing minus, DR/CR and comma decimals", () => {
    expect(imp.parseImportAmount("$1,234.50")).toBe(1234.5);
    expect(imp.parseImportAmount("(42.10)")).toBe(-42.1);
    expect(imp.parseImportAmount("-$5")).toBe(-5);
    expect(imp.parseImportAmount("12.00-")).toBe(-12);
    expect(imp.parseImportAmount("12.00 DR")).toBe(-12);
    expect(imp.parseImportAmount("12.00 CR")).toBe(12);
    expect(imp.parseImportAmount("1.234,56 €", "eu")).toBe(1234.56);
    expect(imp.parseImportAmount("")).toBeNull();
    expect(imp.parseImportAmount("n/a")).toBeNaN();
  });

  it("detects delimiter, preamble and a mapping from header names", () => {
    const { db } = setup();
    const text = [
      "Account statement;;;",
      "Generated 2026-11-01;;;",
      "Booking Date;Payee;Debit;Credit",
      "02.11.2026;Hardware Store;12,50;",
      "15.11.2026;Airbnb;;300,00",
    ].join("\n");
    const r = imp.inspectCsv(db, { text });
    expect(r).toMatchObject({ delimiter: ";", header_row: 2, has_header: true, row_count: 2 });
    expect(r.mapping).toMatchObject({
      amount_mode: "split",
      date_format: "DMY",
      number_format: "eu",
      columns: { date: "Booking Date", reference: "Payee", money_out: "Debit", money_in: "Credit" },
    });
    const p = imp.previewImport(db, { text, mapping: r.mapping });
    expect(p.rows.map((x) => [x.date, x.amount])).toEqual([
      ["2026-11-02", -12.5],
      ["2026-11-15", 300],
    ]);
  });

  it("supports an amount plus a debit/credit indicator column", () => {
    const { db } = setup();
    const text = "Date,Description,Amount,Type\n2026-01-05,Coffee,4.50,Debit\n2026-01-06,Refund,10.00,Credit\n";
    const r = imp.inspectCsv(db, { text });
    expect(r.mapping).toMatchObject({ amount_mode: "direction", outflow_values: ["Debit"] });
    expect(imp.previewImport(db, { text, mapping: r.mapping }).rows.map((x) => x.amount)).toEqual([-4.5, 10]);
  });
});

describe("duplicate check", () => {
  const mapping = {
    columns: { date: "Date", reference: "Description", amount: "Amount" },
    date_format: "YMD" as const,
  };
  const csv = (...lines: string[]) => ["Date,Description,Amount", ...lines].join("\n");

  it("matches exact rows, shifted dates and other wording, one existing row per file row", () => {
    const { db, add } = setup();
    add("2026-05-01", -50, "Supplies", { reference: "HARDWARE STORE #12" });
    add("2026-05-03", -80, "Utilities", { vendor: "Power Co" }); // entered by hand, no bank text
    add("2026-05-10", -20, "Supplies", { reference: "TARGET 1234" });
    add("2026-05-20", -5, "Supplies", { reference: "PARKING" });
    const p = imp.previewImport(db, {
      text: csv(
        "2026-05-01,HARDWARE STORE #12,-50.00", // exact
        "2026-05-05,POWER CO AUTOPAY,-80.00", // 2 days after a hand entry
        "2026-05-10,TGT STORE,-20.00", // same day + amount, different wording
        "2026-05-20,PARKING,-5.00", // exact
        "2026-05-20,PARKING,-5.00", // second identical charge: genuinely new
        "2026-05-25,NEW THING,-9.99",
      ),
      mapping,
    });
    expect(p.rows.map((r) => r.status)).toEqual(["duplicate", "possible", "possible", "duplicate", "new", "new"]);
    expect(p.rows[1]!.match).toMatchObject({ vendor: "Power Co", reason: "same amount, 2 days earlier" });
    expect(p.rows[2]!.match!.reason).toBe("same day and amount, different description");
    expect(p.summary).toMatchObject({ new: 2, duplicate: 2, possible: 2, error: 0 });
  });

  it("ignores rows outside the window and deleted rows, honours the window size", () => {
    const { db, actor, add } = setup();
    add("2026-05-01", -80, "Utilities");
    const gone = add("2026-06-01", -30, "Supplies");
    ledger.deleteTransaction(db, actor, gone.id);
    const text = csv("2026-05-06,POWER,-80", "2026-06-01,X,-30");
    expect(imp.previewImport(db, { text, mapping }).rows.map((r) => r.status)).toEqual(["new", "new"]);
    expect(imp.previewImport(db, { text, mapping, window_days: 5 }).rows[0]!.status).toBe("possible");
  });

  it("matches by transaction id even for deleted rows", () => {
    const { db, actor } = setup();
    const m = { ...mapping, columns: { ...mapping.columns, external_id: "Id" }, account: "Visa" };
    const text = "Date,Description,Amount,Id\n2026-07-01,A,-10,abc\n2026-07-02,B,-11,def\n";
    const first = imp.previewImport(db, { text, mapping: m });
    expect(first.rows.map((r) => r.external_id)).toEqual(["csv:Visa:abc", "csv:Visa:def"]);
    const res = imp.commitImport(db, actor, {
      transactions: first.rows.map((r) => ({
        date: r.date,
        amount: r.amount,
        category: "Supplies",
        reference: r.reference,
        external_id: r.external_id,
        refund: true,
      })),
    });
    expect(res.created).toBe(2);
    ledger.deleteTransaction(db, actor, res.results[1]!.id!);
    const again = imp.previewImport(db, { text, mapping: m });
    expect(again.rows.map((r) => r.status)).toEqual(["duplicate", "duplicate"]);
    expect(again.rows[1]!.match).toMatchObject({
      deleted: true,
      reason: "same transaction id (a deleted transaction)",
    });
  });

  it("commits rows the user re-included, and the import can be undone", () => {
    const { db, actor, add } = setup();
    add("2026-08-01", -25, "Supplies", { reference: "SHOP" });
    const res = imp.commitImport(db, actor, {
      transactions: [{ date: "2026-08-01", amount: -25, category: "Supplies", reference: "SHOP", refund: true }],
    });
    expect(res.created).toBe(1);
    expect(res.audit_id).toBe(listAudit(db, { limit: 5 }).find((e) => e.action === "bulk_create")!.id);
    undoAudit(db, actor, res.audit_id!);
    expect(ledger.listTransactions(db, {}).total).toBe(1);
  });
});

describe("rows", () => {
  it("reports unreadable rows and guesses categories from the file and history", () => {
    const { db, add } = setup();
    add("2026-01-01", -40, "Cleaning", { vendor: "Sparkle Clean", subcategory: "Turnover" });
    const text = [
      "Date,Description,Amount,Category",
      "2026-02-01,SPARKLE CLEAN LLC,-45,",
      "2026-02-02,Insurance co,-100,insurance",
      "bad,Oops,-1,",
      "2026-02-03,Nothing,,",
      "2026-02-04,Odd,-3,Not a category",
    ].join("\n");
    const p = imp.previewImport(db, {
      text,
      mapping: { columns: { date: "Date", reference: "Description", amount: "Amount", category: "Category" } },
    });
    const [a, b, c, d, e] = p.rows;
    expect(a).toMatchObject({ category_source: "history", vendor: "Sparkle Clean", subcategory: "Turnover" });
    expect(b).toMatchObject({ category_source: "file" });
    expect(c).toMatchObject({ status: "error", errors: ['Can\'t read the date "bad"'] });
    expect(d).toMatchObject({ status: "error", errors: ["No amount"] });
    expect(e).toMatchObject({ category_id: null, warnings: ['No category named "Not a category"'] });
    expect(() => imp.previewImport(db, { text, mapping: { columns: { date: "Nope", amount: "Amount" } } })).toThrow(
      /not in this file/,
    );
  });
});

describe("profiles", () => {
  it("saves a profile and picks it for a file with the same headers", () => {
    const { db, actor } = setup();
    const text = "Posted,Payee,Amt,Memo\n01/02/2026,Shop,12.00,x\n";
    const mapping = imp.importMapping.parse({
      columns: { date: "Posted", reference: "Payee", amount: "Amt", description: "Memo" },
      negate: true,
      account: "Visa",
    });
    const saved = imp.saveProfile(db, actor, {
      name: "Visa card",
      headers: ["Posted", "Payee", "Amt", "Memo"],
      mapping,
    });
    // same name (any case) replaces it
    imp.saveProfile(db, actor, { name: "visa CARD", headers: saved.headers, mapping });
    expect(imp.listProfiles(db)).toHaveLength(1);
    const r = imp.inspectCsv(db, { text });
    expect(r.profile).toMatchObject({ id: saved.id });
    expect(r.mapping).toMatchObject({ negate: true, account: "Visa" });
    const p = imp.previewImport(db, { text, mapping: r.mapping });
    expect(p.rows[0]).toMatchObject({ amount: -12, account: "Visa", description: "x" });
    imp.deleteProfile(db, actor, saved.id);
    expect(imp.inspectCsv(db, { text }).profile).toBeNull();
  });
});

describe("real-world layouts", () => {
  const guess = (header: string, ...rows: string[]) => {
    const { db } = setup();
    return imp.inspectCsv(db, { text: [header, ...rows].join("\n") }).mapping;
  };

  it("Chase-style checking: Details is the debit/credit flag, Description the text", () => {
    const m = guess(
      "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
      "DEBIT,11/03/2026,HOME DEPOT 123,-45.10,DEBIT_CARD,1000.00,",
      "CREDIT,11/04/2026,AIRBNB PAYOUT,800.00,ACH_CREDIT,1800.00,",
    );
    expect(m.columns).toMatchObject({ date: "Posting Date", reference: "Description", amount: "Amount" });
    expect(m).toMatchObject({ amount_mode: "direction", outflow_values: ["DEBIT"] });
  });

  it("card with Debit/Credit columns and a text 'Details' column", () => {
    const m = guess(
      "Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit",
      "2026-11-01,2026-11-02,1234,COSTCO,Merchandise,52.10,",
    );
    expect(m.columns).toMatchObject({
      date: "Transaction Date",
      reference: "Description",
      money_out: "Debit",
      money_in: "Credit",
      category: "Category",
    });
    expect(m.amount_mode).toBe("split");
    const d = guess("Date,Details,Amount", "2026-01-01,Coffee shop downtown,-4");
    expect(d.columns).toMatchObject({ reference: "Details", amount: "Amount" });
    expect(d.amount_mode).toBe("signed");
  });

  it("a 'Credit Debit Indicator' column is a direction, not money out", () => {
    const m = guess("Date,Description,Amount,Credit Debit Indicator", "2026-01-01,Shop,4.00,Debit");
    expect(m.columns).toMatchObject({ direction: "Credit Debit Indicator", amount: "Amount" });
    expect(m.amount_mode).toBe("direction");
  });

  it("no header row: date, amount and the widest text column", () => {
    const m = guess("01/05/2026,-12.00,LOCAL HARDWARE STORE,X", "01/06/2026,300.00,AIRBNB PAYOUT,Y");
    expect(m).toMatchObject({ has_header: false, columns: { date: "#1", amount: "#2", reference: "#3" } });
  });
});

describe("commit with transaction ids", () => {
  it("adds twins with different ids and re-included look-alikes", () => {
    const { db, actor, add } = setup();
    add("2026-09-01", -5, "Supplies", { reference: "PARKING" });
    const row = (id: string) => ({
      date: "2026-09-01",
      amount: -5,
      category: "Supplies",
      reference: "PARKING",
      external_id: `csv:${id}`,
      refund: true,
    });
    const res = imp.commitImport(db, actor, { transactions: [row("a"), row("b"), row("c")] });
    expect(res).toMatchObject({ created: 3, duplicates: 0 });
    // the same ids again are refused, also twice within one batch
    expect(imp.commitImport(db, actor, { transactions: [row("a"), row("d"), row("d")] })).toMatchObject({
      created: 1,
      duplicates: 2,
    });
  });
});
