/**
 * "Download everything": everything in the current portfolio as one zip, for its own people (a whole-server backup
 * holds every portfolio, so it's only for the server's administrator). CSVs a spreadsheet opens, plus the receipts
 * and manager paperwork as files. Streamed one file at a time (services/zip.ts).
 */
import { existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { and, asc, eq, isNull } from "drizzle-orm";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { attachments, categories, managerDocuments, subcategories, taxYears, transactions } from "../db/schema.ts";
import { audit, dollars, type Actor } from "../context.ts";
import { currentPortfolio } from "./portfolios.ts";
import { propertyScope } from "../portfolio.ts";
import { toCsv, transactionsCsv } from "./csv.ts";
import { categoriesInPortfolio, listCategories, listProperties, listTransactions, txInPortfolio } from "./ledger.ts";
import { listOwnerStays, occupancyRows } from "./owner-stays.ts";
import { gatedZipStream, type ZipSource } from "./zip.ts";

const safe = (s: string) =>
  s
    .replace(/[^\w .&()$,-]+/g, "")
    .replace(/\s+/g, " ")
    .trim() || "file";

const README = (name: string, when: string) => `${name}: exported from Rental Ledger on ${when}.

Transactions.csv       every entry (signed amounts: income positive, expenses negative)
Properties.csv         the properties, with placed-in-service date and depreciable basis
Categories.csv         categories and their subcategories, with receipt rules and Schedule E lines
Occupancy.csv          nights booked, owner nights and check-ins per property and month
Owner stays.csv        personal-use stays by date (checkout day not counted)
Tax years.csv          per-year inputs such as Form 1098 mortgage interest
Receipts/              every receipt, named by property, date, vendor and amount (#entry id)
Manager paperwork/     saved owner statements and invoices, by property and month
`;

/** All live entries, oldest first (the list API pages at 5000). */
function allTransactions(db: DB) {
  const out: object[] = [];
  for (let offset = 0; ; offset += 5000) {
    const { items } = listTransactions(db, { sort: "date_asc", limit: 5000, offset });
    out.push(...items);
    if (items.length < 5000) return out;
  }
}

export function portfolioExport(db: DB, actor: Actor | null) {
  const portfolio = currentPortfolio(db);
  const when = new Date().toISOString().slice(0, 10);
  const root = resolve(config.uploadsDir);
  const used = new Set<string>();
  const file = (base: string, ext: string, key: string): ZipSource | null => {
    const path = resolve(root, key);
    if (!path.startsWith(root + sep) || !existsSync(path)) return null;
    let name = `${base}${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}${ext}`;
    used.add(name.toLowerCase());
    return { name, path };
  };

  const txs = allTransactions(db);
  const props = listProperties(db);
  const propName = new Map(props.map((p) => [p.id, safe(p.name)]));
  const cats = listCategories(db);
  const subs = db
    .select({ categoryId: subcategories.categoryId, name: subcategories.name, rule: subcategories.receiptPolicy })
    .from(subcategories)
    .innerJoin(categories, eq(categories.id, subcategories.categoryId))
    .where(categoriesInPortfolio(db))
    .all();

  const receipts = db
    .select({
      key: attachments.storageKey,
      filename: attachments.filename,
      txId: transactions.id,
      propertyId: transactions.propertyId,
      date: transactions.date,
      vendor: transactions.vendor,
      amount: transactions.amountCents,
    })
    .from(attachments)
    .innerJoin(transactions, eq(transactions.id, attachments.transactionId))
    .where(and(txInPortfolio(db), isNull(transactions.deletedAt)))
    .orderBy(asc(transactions.date), asc(attachments.id))
    .all()
    .map((r) =>
      file(
        `Receipts/${propName.get(r.propertyId)}/${r.date} - ${safe(r.vendor || "entry")} - ${(Math.abs(r.amount) / 100).toFixed(2)} (#${r.txId})`,
        extname(r.filename) || extname(r.key),
        r.key,
      ),
    )
    .filter((f): f is ZipSource => f != null);
  const paperwork = db
    .select()
    .from(managerDocuments)
    .where(propertyScope(db, managerDocuments.propertyId))
    .orderBy(asc(managerDocuments.month), asc(managerDocuments.id))
    .all()
    .map((d) =>
      file(
        `Manager paperwork/${propName.get(d.propertyId)}/${d.month} ${d.kind}${d.reference ? ` ${safe(d.reference)}` : ""}`,
        extname(d.filename) || extname(d.storageKey),
        d.storageKey,
      ),
    )
    .filter((f): f is ZipSource => f != null);

  const csv = (rows: Record<string, unknown>[]) => Buffer.from(toCsv(rows));
  const sources: ZipSource[] = [
    { name: "README.txt", data: Buffer.from(README(portfolio.name, when)) },
    { name: "Transactions.csv", data: Buffer.from(transactionsCsv(txs)) },
    { name: "Properties.csv", data: csv(props.map((p) => ({ ...p }))) },
    {
      name: "Categories.csv",
      data: csv(
        cats.flatMap((c) => [
          {
            category: c.name,
            subcategory: "",
            kind: c.kind,
            schedule_e_line: c.schedule_e_line,
            default_allocation: c.default_allocation,
            receipt_policy: c.receipt_policy,
            receipt_min: c.receipt_min,
            archived: c.archived,
          },
          ...subs
            .filter((s) => s.categoryId === c.id)
            .map((s) => ({ category: c.name, subcategory: s.name, kind: c.kind, receipt_policy: s.rule ?? "" })),
        ]),
      ),
    },
    { name: "Occupancy.csv", data: csv(occupancyRows(db).map((o) => ({ ...o }))) },
    { name: "Owner stays.csv", data: csv(listOwnerStays(db).map((s) => ({ ...s }))) },
    {
      name: "Tax years.csv",
      data: csv(
        db
          .select()
          .from(taxYears)
          .where(propertyScope(db, taxYears.propertyId))
          .all()
          .map((t) => ({
            property: propName.get(t.propertyId),
            year: t.year,
            mortgage_interest: dollars(t.mortgageInterestCents),
            rental_days_override: t.rentalDaysOverride,
            personal_days_override: t.personalDaysOverride,
            notes: t.notes,
          })),
      ),
    },
    ...receipts,
    ...paperwork,
  ];
  const { stream } = gatedZipStream(sources);
  audit(db, actor, "export", "download", null, {
    transactions: txs.length,
    receipts: receipts.length,
    manager_documents: paperwork.length,
  });
  return { filename: `${safe(portfolio.name)} ${when}.zip`, stream };
}
