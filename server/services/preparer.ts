/**
 * Everything the tax preparer needs for one year, in one zip: a readable summary, the tax report and all of the
 * year's transactions as CSV, and the receipts (named by date, category and amount).
 */
import { existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { and, between, eq, isNull } from "drizzle-orm";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { attachments, categories, transactions } from "../db/schema.ts";
import { audit, type Actor } from "../context.ts";
import { transactionsCsv } from "./csv.ts";
import { listTransactions } from "./ledger.ts";
import { taxReport, taxReportCsv } from "./reports.ts";
import { gatedZipStream, type ZipSource } from "./zip.ts";

const usd = (n: number) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const row = (label: string, value: string, width = 44) => `  ${label.padEnd(width, ".")} ${value.padStart(14)}`;
const safe = (s: string) => s.replace(/[^\w .&()-]+/g, "").trim() || "receipt";

function summaryText(r: ReturnType<typeof taxReport>, receipts: number) {
  const L: string[] = [];
  L.push(`${r.property.name} — rental income and expenses for ${r.year}`);
  if (r.property.address) L.push(r.property.address);
  L.push(`Prepared ${new Date().toISOString().slice(0, 10)} from the Rental Ledger. Cash basis (date paid).`, "");

  L.push("INCOME");
  for (const l of r.income.by_category) L.push(row(l.category, usd(l.amount)));
  const payers = r.income.by_payer.filter((p) => p.payer !== "(unspecified)");
  if (payers.length) for (const p of r.income.by_payer) L.push(row(`  from ${p.payer}`, usd(p.amount)));
  L.push(row("Gross rental income", usd(r.income.total)), "");

  L.push("DIRECT EXPENSES (rental only, deducted in full)");
  for (const l of r.expenses.direct.by_category)
    L.push(row(`${l.category} (Sch E line ${l.schedule_e_line ?? "19"})`, usd(l.amount)));
  L.push(row("Total direct", usd(r.expenses.direct.total)), "");

  L.push("INDIRECT EXPENSES (whole property, split by rental use)");
  for (const l of r.expenses.indirect.by_category)
    L.push(row(`${l.category} (Sch E line ${l.schedule_e_line ?? "19"})`, usd(l.amount)));
  L.push(row("Total indirect", usd(r.expenses.indirect.total)));
  L.push(
    row(
      `Deductible share at ${(r.use.rental_pct * 100).toFixed(2)}% rental use`,
      usd(r.allocation.indirect_deductible),
    ),
    "",
  );
  if (r.expenses.unallocated.total) {
    L.push("NOT YET MARKED DIRECT OR INDIRECT (left out of the totals)");
    for (const l of r.expenses.unallocated.by_category) L.push(row(l.category, usd(l.amount)));
    L.push("");
  }

  L.push("RENTAL VS PERSONAL USE");
  L.push(row("Days rented", String(r.use.rental_days)));
  L.push(row("Days of personal use", String(r.use.personal_days)));
  L.push(row("Rental use %", `${(r.use.rental_pct * 100).toFixed(2)}%`));
  if (r.use.avg_stay != null) L.push(row("Average guest stay (nights)", String(r.use.avg_stay)));
  L.push("");

  if (r.mortgage.payments_recorded)
    L.push(
      "MORTGAGE",
      row("Mortgage payments recorded", usd(r.mortgage.payments_recorded)),
      row("Interest from Form 1098", r.mortgage.interest_1098 != null ? usd(r.mortgage.interest_1098) : "not entered"),
      "",
    );
  if (r.depreciation)
    L.push(
      "DEPRECIATION (estimate)",
      row("Building basis", usd(r.depreciation.basis)),
      row("Placed in service", r.depreciation.placed_in_service),
      row(`This year (${r.depreciation.recovery_years}-year straight line)`, usd(r.depreciation.full_year)),
      "",
    );

  L.push("SCHEDULE E (estimate)");
  for (const l of r.schedule_e) L.push(row(`Line ${l.line} ${l.label}`, usd(l.total)));
  L.push(row("Total deductible expenses", usd(r.totals.deductible_expenses)));
  L.push(row("Net", usd(r.totals.net)), "");

  if (r.checks.length) {
    L.push("NOTES / ITEMS TO CONFIRM");
    for (const c of r.checks) L.push(`  - ${c.message}`);
    L.push("");
  }
  L.push("FILES IN THIS PACKAGE");
  const file = (name: string, what: string) => L.push(`  ${name.padEnd(28)} ${what}`);
  file("Summary.txt", "this page");
  file(`Tax summary ${r.year}.csv`, "the numbers above, for a spreadsheet");
  file(`Transactions ${r.year}.csv`, "every income and expense entry for the year");
  if (receipts) file("Receipts/", `${receipts} receipt file(s), named date - category - amount`);
  else L.push(`  (no receipts attached for ${r.year})`);
  L.push("", r.disclaimer, "");
  return L.join("\n");
}

/** Build the preparer package for a year. Any signed-in user can download it. */
export function preparerPackage(db: DB, actor: Actor | null, year: number, propertyRef?: number | string) {
  const r = taxReport(db, year, propertyRef);
  const t = transactions;
  const { items } = listTransactions(db, {
    year,
    property_id: r.property.id,
    sort: "date_asc",
    limit: 5000,
  });

  const root = resolve(config.uploadsDir);
  const files = db
    .select({
      key: attachments.storageKey,
      filename: attachments.filename,
      txId: t.id,
      date: t.date,
      amount: t.amountCents,
      category: categories.name,
    })
    .from(attachments)
    .innerJoin(t, eq(t.id, attachments.transactionId))
    .innerJoin(categories, eq(categories.id, t.categoryId))
    .where(and(isNull(t.deletedAt), eq(t.propertyId, r.property.id), between(t.date, `${year}-01-01`, `${year}-12-31`)))
    .orderBy(t.date, t.id)
    .all();
  const receipts: ZipSource[] = [];
  const used = new Set<string>();
  for (const f of files) {
    const p = resolve(root, f.key);
    if (!p.startsWith(root + sep) || !existsSync(p)) continue;
    const base = `Receipts/${f.date} - ${safe(f.category)} - ${(Math.abs(f.amount) / 100).toFixed(2)} (#${f.txId})`;
    let name = `${base}${extname(f.filename) || extname(f.key)}`;
    for (let n = 2; used.has(name); n++) name = `${base} ${n}${extname(f.filename) || extname(f.key)}`;
    used.add(name);
    receipts.push({ name, path: p });
  }

  const { stream } = gatedZipStream([
    { name: "Summary.txt", data: Buffer.from(summaryText(r, receipts.length)) },
    { name: `Tax summary ${year}.csv`, data: Buffer.from(taxReportCsv(r)) },
    { name: `Transactions ${year}.csv`, data: Buffer.from(transactionsCsv(items)) },
    ...receipts,
  ]);
  audit(db, actor, "export", "preparer_package", null, {
    year,
    property: r.property.name,
    transactions: items.length,
    receipts: receipts.length,
  });
  return {
    filename: `${safe(r.property.name)} ${year} tax package.zip`,
    stream,
    transactions: items.length,
    receipts: receipts.length,
  };
}
