import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { users, stateTaxFilings, transactions } = await import("./db/schema.ts");
const ledger = await import("./services/ledger.ts");
const docs = await import("./services/manager-documents.ts");
const st = await import("./services/state-tax.ts");
const { todoSummary } = await import("./services/todo.ts");
const { eq } = await import("drizzle-orm");

// All names, ids and amounts below are invented. Columns match by suffix, like any manager's export.
const HEADER = 'Guest,Channel,"Check-in date","Check-out date",XyzOwnerPayout,XyzTaxes,Nights,"Reservation ID"';
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");
const row = (id: string, ch: string, ci: string, co: string, payout: string, taxes = "$0.00", nights = "3") =>
  `"Guest ${id}",${ch},${ci},${co},"${payout}","${taxes}",${nights},${id}`;

function setup() {
  const db = openDb(":memory:");
  seedDefaults(db);
  const user = db.insert(users).values({ email: "t@example.com", role: "admin" }).returning().get();
  const actor = { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  const save = (month: string, body: string) =>
    docs.saveDocuments(
      db,
      actor,
      [{ filename: `${month}.csv`, contentType: "text/csv", data: new TextEncoder().encode(body) }],
      { month },
    );
  return { db, actor, save };
}

describe("quarters", () => {
  it("puts a date in its calendar quarter", () => {
    expect(st.quarterOf("2026-03-31")).toEqual({ year: 2026, quarter: 1 });
    expect(st.quarterOf("2026-04-01")).toEqual({ year: 2026, quarter: 2 });
    expect(st.quarterOf("2026-12-31")).toEqual({ year: 2026, quarter: 4 });
    expect(st.quarterOf("2027-01-01")).toEqual({ year: 2027, quarter: 1 });
    expect(st.quarterRange({ year: 2028, quarter: 1 })).toEqual({ start: "2028-01-01", end: "2028-03-31" });
    expect(st.quarterRange({ year: 2026, quarter: 4 })).toEqual({ start: "2026-10-01", end: "2026-12-31" });
  });

  it("is due the 20th of the month after the quarter, Q4 in January of the next year", () => {
    expect([1, 2, 3, 4].map((quarter) => st.dueDate({ year: 2026, quarter }))).toEqual([
      "2026-04-20",
      "2026-07-20",
      "2026-10-20",
      "2027-01-20",
    ]);
  });
});

describe("quarter gross", () => {
  it("adds non-Airbnb, non-cancelled payouts by check-in date, across statements, each stay once", async () => {
    const { db, save } = setup();
    await save(
      "2026-01",
      csv(
        row("V1", "vrbo", "2026-01-05", "2026-01-08", "$1,000.10", "$80.00"),
        row("A1", "airbnbOfficial", "2026-01-10", "2026-01-12", "$500.00"),
        row("A2", "AIRBNB", "2026-01-14", "2026-01-16", "$300.00"),
        row("A3", "Airbnb.com", "2026-01-18", "2026-01-19", "$100.00"),
      ),
    );
    await save("2026-02", csv(row("D1", "Booking Engine", "2026-02-02", "2026-02-04", "$400.20", "$32.00")));
    await save(
      "2026-03",
      csv(
        row("D1", "Booking Engine", "2026-02-02", "2026-02-04", "$400.20", "$32.00"), // listed again
        row("C1", "vrbo", "2026-03-05", "2026-03-08", "$50.00", "$0.00", "0"), // cancelled: 0 nights
        row("V0", "vrbo", "2025-12-30", "2026-01-02", "$700.00"), // Q4 of last year: checked in Dec 30
      ),
    );
    // checks in Mar 31, out Apr 2: on April's statement, counted in Q1
    await save(
      "2026-04",
      csv(
        row("V2", "VRBO", "2026-03-31", "2026-04-02", "$600.00", "$48.00"),
        row("V3", "vrbo", "2026-04-01", "2026-04-03", "$999.00"),
      ),
    );

    const q1 = st.stateTaxQuarter(db, { year: 2026, quarter: 1, today: "2026-04-10" });
    expect(q1.reservations.map((r) => r.reservation_id)).toEqual(["V1", "D1", "V2"]);
    expect(q1.gross).toBe(2000.3);
    expect(q1.taxes_collected).toBe(160);
    expect(q1.excluded.airbnb).toEqual({ count: 3, payout: 900 });
    expect(q1.excluded.cancelled.count).toBe(1);
    expect(q1.warnings).toEqual([]);
    expect(q1.complete).toBe(true);
    expect(q1.status).toBe("open");

    const q2 = st.stateTaxQuarter(db, { year: 2026, quarter: 2, today: "2026-04-10" });
    expect(q2.reservations.map((r) => r.reservation_id)).toEqual(["V3"]);
    expect(q2.status).toBe("in_progress");
    const q4 = st.stateTaxQuarter(db, { year: 2025, quarter: 4, today: "2026-04-10" });
    expect(q4.reservations.map((r) => r.reservation_id)).toEqual(["V0"]);
    expect(q4.missing_months).toEqual(["2025-10", "2025-11", "2025-12"]);
  });

  it("counts Dec 31 in Q4 and Jan 1 in Q1 of the next year", async () => {
    const { db, save } = setup();
    await save(
      "2027-01",
      csv(
        row("X1", "vrbo", "2026-12-31", "2027-01-03", "$300.00"),
        row("X2", "vrbo", "2027-01-01", "2027-01-04", "$200.00"),
      ),
    );
    const y = st.stateTaxYear(db, { year: 2026, today: "2027-02-01" });
    expect(y.quarters[3]!.gross).toBe(300);
    expect(y.quarters[3]!.due_date).toBe("2027-01-20");
    expect(y.quarters[3]!.status).toBe("overdue");
    expect(st.stateTaxQuarter(db, { year: 2027, quarter: 1, today: "2027-02-01" }).gross).toBe(200);
  });

  it("warns about months of the quarter without a statement, and a missing next month as a note", async () => {
    const { db, save } = setup();
    await save("2026-07", csv(row("V1", "vrbo", "2026-07-05", "2026-07-08", "$100.00")));
    await save("2026-09", csv(row("V2", "vrbo", "2026-09-05", "2026-09-08", "$100.00")));
    const q = st.stateTaxQuarter(db, { year: 2026, quarter: 3, today: "2026-10-05" });
    expect(q.missing_months).toEqual(["2026-08"]);
    expect(q.warnings).toHaveLength(1);
    expect(q.warnings[0]).toContain("No manager statement is saved for August 2026");
    expect(q.notes[0]).toContain("No statement for October 2026");
    expect(q.complete).toBe(false);
  });

  it("warns when counted reservations have no channel", async () => {
    const { db, save } = setup();
    await save("2026-07", csv(row("N1", "", "2026-07-05", "2026-07-08", "$100.00")));
    const q = st.stateTaxQuarter(db, { year: 2026, quarter: 3, today: "2026-07-20" });
    expect(q.gross).toBe(100);
    expect(q.warnings.some((w) => w.includes("no channel"))).toBe(true);
  });
});

describe("paying a quarter", () => {
  const taxesRows = (db: ReturnType<typeof setup>["db"]) =>
    ledger.listTransactions(db, { category: "Taxes", limit: 50 }).items;

  it("creates exactly one Taxes expense (no subcategory, direct), linked, and replays safely", async () => {
    const { db, actor, save } = setup();
    await save("2026-07", csv(row("V1", "vrbo", "2026-07-05", "2026-07-08", "$1,234.56")));
    await save("2026-08", csv(row("A1", "airbnb", "2026-08-05", "2026-08-08", "$10.00")));
    await save("2026-09", csv(row("A2", "airbnb", "2026-09-05", "2026-09-08", "$10.00")));
    const input = { year: 2026, quarter: 3, paid_date: "2026-10-15", amount_paid: 98.76, confirmation: "CONF-1" };
    const r = st.markStateTaxPaid(db, actor, input);
    expect(r.status).toBe("paid");
    expect(r.filing).toMatchObject({ amount_paid: 98.76, gross_filed: 1234.56, confirmation: "CONF-1" });
    const rows = taxesRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount: -98.76,
      subcategory: "",
      allocation: "direct",
      date: "2026-10-15",
      reference: "CONF-1",
    });
    expect(r.filing!.transaction_id).toBe(rows[0]!.id);
    expect(r.filing!.expense_warning).toBeNull();

    // the same request again (double tap, retry) changes nothing
    expect(st.markStateTaxPaid(db, actor, input).filing!.id).toBe(r.filing!.id);
    expect(taxesRows(db)).toHaveLength(1);
    // a different payment is refused until cleared
    expect(() => st.markStateTaxPaid(db, actor, { ...input, amount_paid: 50 })).toThrow(/already marked paid/);
    expect(taxesRows(db)).toHaveLength(1);
  });

  it("links an existing expense instead of creating one, and won't link it twice", () => {
    const { db, actor } = setup();
    const t = ledger.createTransaction(db, actor, { date: "2026-04-18", amount: -55.5, category: "Taxes" });
    const q1 = st.stateTaxQuarter(db, { year: 2026, quarter: 1, today: "2026-05-01" });
    expect(q1.candidates.map((c) => c.id)).toEqual([t.id]);
    const r = st.markStateTaxPaid(db, actor, { year: 2026, quarter: 1, transaction_id: t.id, gross_filed: 900 });
    expect(r.filing).toMatchObject({
      amount_paid: 55.5,
      paid_date: "2026-04-18",
      transaction_id: t.id,
      gross_filed: 900,
    });
    expect(taxesRows(db)).toHaveLength(1);
    // without statements the computed gross ($0) isn't recorded as what was filed
    const other = ledger.createTransaction(db, actor, { date: "2025-10-15", amount: -20, category: "Taxes" });
    expect(
      st.markStateTaxPaid(db, actor, { year: 2025, quarter: 3, transaction_id: other.id }).filing!.gross_filed,
    ).toBeNull();
    expect(() => st.markStateTaxPaid(db, actor, { year: 2026, quarter: 2, transaction_id: t.id })).toThrow(
      /already the payment for Q1 2026/,
    );
    expect(st.stateTaxQuarter(db, { year: 2026, quarter: 2 }).candidates).toEqual([]);
  });

  it("refuses an income row or another property's expense as the payment", () => {
    const { db, actor } = setup();
    const other = ledger.createProperty(db, actor, { name: "Other Place" });
    const theirs = ledger.createTransaction(db, actor, {
      property_id: other.id,
      date: "2026-04-18",
      amount: -10,
      category: "Taxes",
    });
    const props = ledger.listProperties(db);
    const mine = props.find((p) => p.id !== other.id)!;
    expect(() =>
      st.markStateTaxPaid(db, actor, { property: mine.id, year: 2026, quarter: 1, transaction_id: theirs.id }),
    ).toThrow(/another property/);
    const income = ledger.createTransaction(db, actor, {
      property_id: mine.id,
      date: "2026-04-18",
      amount: 10,
      category: "Rental Income",
    });
    expect(() =>
      st.markStateTaxPaid(db, actor, { property: mine.id, year: 2026, quarter: 1, transaction_id: income.id }),
    ).toThrow(/isn't an expense/);
  });

  it("clearing keeps the expense unless asked to trash it, and shows a trashed or changed expense", () => {
    const { db, actor } = setup();
    const paid = st.markStateTaxPaid(db, actor, { year: 2026, quarter: 2, paid_date: "2026-07-10", amount_paid: 40 });
    const txId = paid.filing!.transaction_id!;
    ledger.updateTransaction(db, actor, txId, { amount: -41 });
    expect(st.stateTaxQuarter(db, { year: 2026, quarter: 2 }).filing!.expense_warning).toContain("$41.00");

    const cleared = st.clearStateTaxPaid(db, actor, { year: 2026, quarter: 2 });
    expect(cleared).toMatchObject({ transaction_id: txId, expense_trashed: false });
    expect(cleared.quarter.filing).toBeNull();
    expect(ledger.getTransaction(db, txId).amount).toBe(-41); // still in the ledger, as edited
    // the kept expense is offered for linking again
    expect(st.stateTaxQuarter(db, { year: 2026, quarter: 2 }).candidates.map((c) => c.id)).toEqual([txId]);

    st.markStateTaxPaid(db, actor, { year: 2026, quarter: 2, transaction_id: txId });
    ledger.deleteTransaction(db, actor, txId);
    expect(st.stateTaxQuarter(db, { year: 2026, quarter: 2 }).filing!.expense_warning).toContain("trash");
    ledger.restoreTransaction(db, actor, txId);
    const trashed = st.clearStateTaxPaid(db, actor, { year: 2026, quarter: 2, trash_expense: true });
    expect(trashed.expense_trashed).toBe(true);
    expect(() => ledger.getTransaction(db, txId)).toThrow(/not found/);
    expect(db.select().from(stateTaxFilings).all()).toEqual([]);
    expect(db.select().from(transactions).where(eq(transactions.id, txId)).get()!.deletedAt).not.toBeNull();
  });

  it("audits every write and refuses read-only accounts", () => {
    const { db, actor } = setup();
    expect(() =>
      st.markStateTaxPaid(
        db,
        { ...actor, canWrite: false },
        {
          year: 2026,
          quarter: 1,
          paid_date: "2026-04-10",
          amount_paid: 1,
        },
      ),
    ).toThrow(/read-only/);
    st.markStateTaxPaid(db, actor, { year: 2026, quarter: 1, paid_date: "2026-04-10", amount_paid: 1 });
    st.clearStateTaxPaid(db, actor, { year: 2026, quarter: 1 });
    const log = db.$client
      .prepare("SELECT action, entity FROM audit_log WHERE entity = 'state_tax_filing' ORDER BY id")
      .all();
    expect(log).toEqual([
      { action: "create", entity: "state_tax_filing" },
      { action: "delete", entity: "state_tax_filing" },
    ]);
  });
});

describe("To do", () => {
  it("asks about an ended, unpaid quarter from two weeks before it's due, and every day it's overdue", async () => {
    const { db, actor, save } = setup();
    await save("2026-07", csv(row("V1", "vrbo", "2026-07-05", "2026-07-08", "$100.00")));
    const id = ledger.listProperties(db)[0]!.id;
    // no Location ID and nothing paid: this property doesn't file, so no reminder
    expect(st.stateTaxAttention(db, { today: "2026-10-10" })).toEqual([]);
    st.setLocationId(db, actor, { property: id, location_id: "12345-0001" });

    expect(st.stateTaxAttention(db, { today: "2026-10-05" })).toEqual([]); // 15 days left
    const soon = st.stateTaxAttention(db, { today: "2026-10-06" });
    expect(soon).toMatchObject([
      { label: "Q3 2026", status: "open", days_left: 14, gross: 100, location_id: "12345-0001" },
    ]);
    const late = st.stateTaxAttention(db, { today: "2026-11-21" });
    expect(late).toMatchObject([{ label: "Q3 2026", status: "overdue", days_left: -32 }]);
    // Q2 and earlier are before the first saved statement: not reported
    expect(late).toHaveLength(1);

    const before = todoSummary(db, { propertyId: id, today: "2026-11-21" });
    expect(before.state_tax).toBe(1);
    st.markStateTaxPaid(db, actor, { year: 2026, quarter: 3, paid_date: "2026-11-21", amount_paid: 3 });
    const after = todoSummary(db, { propertyId: id, today: "2026-11-21" });
    expect(after.state_tax).toBe(0);
    expect(after.total).toBe(before.total - 1);
  });

  it("doesn't report a quarter that hasn't ended, and looks back at most a year", () => {
    const { db, actor } = setup();
    st.setLocationId(db, actor, { location_id: "1" });
    st.markStateTaxPaid(db, actor, { year: 2024, quarter: 1, paid_date: "2024-04-10", amount_paid: 1 });
    const items = st.stateTaxAttention(db, { today: "2026-12-25" });
    expect(items.map((i) => i.label)).toEqual(["Q4 2025", "Q1 2026", "Q2 2026", "Q3 2026"]);
  });
});

describe("preparer summary", () => {
  it("has a line per quarter with gross filed, amount paid and date", () => {
    const { db, actor } = setup();
    st.setLocationId(db, actor, { location_id: "LOC-9" });
    st.markStateTaxPaid(db, actor, {
      year: 2026,
      quarter: 2,
      paid_date: "2026-07-15",
      amount_paid: 12.5,
      gross_filed: 1500,
    });
    const id = ledger.listProperties(db)[0]!.id;
    const lines = st.stateTaxSummaryLines(db, id, 2026, "2026-11-21");
    expect(lines[0]).toContain("Location ID LOC-9");
    expect(lines.filter((l) => /^ {2}Q\d/.test(l))).toHaveLength(4);
    expect(lines.find((l) => l.includes("Q2"))).toContain("gross filed $1,500.00, paid $12.50 on 2026-07-15");
    expect(lines.find((l) => l.includes("Q3"))).toContain("not paid");
    expect(lines.find((l) => l.includes("Q4"))).toContain("quarter not over");
  });
});
