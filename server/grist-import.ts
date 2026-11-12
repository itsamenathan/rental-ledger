/**
 * One-way, read-only import from a Grist income/expense document.
 * Only GET requests are made against Grist. Re-running is safe: rows are matched by
 * external_id (grist:<docId>:<rowId>) and updated in place if they changed in Grist.
 */
import { and, count, eq, notExists, sql } from "drizzle-orm";
import type { DB } from "./db.ts";
import { tx } from "./db.ts";
import { categories, properties, transactions } from "./db/schema.ts";
import { audit } from "./context.ts";
import { createCategory, createProperty, listCategories, listProperties, type Category } from "./services/ledger.ts";
import { upsertOccupancy } from "./services/rental.ts";

interface GristOpts {
  baseUrl: string;
  apiKey: string;
  docId: string;
  /** Property name. Omitted: the only existing property, else "My Rental". */
  property?: string;
  dryRun: boolean;
  log?: (msg: string) => void;
}

/** Grist name → app name. Other names are kept as-is. */
const RENAME: Record<string, string> = { Income: "Rental Income", "Managment Fee": "Management Fee" };
const SCHEDULE_E: Record<string, string> = {
  "Rental Income": "3",
  Cleaning: "7",
  Furnishings: "19",
  Maintenance: "14",
  "Management Fee": "11",
  Mortgage: "12",
  Services: "19",
  Supplies: "15",
  Taxes: "16",
  Utilities: "17",
  "VRBO Fees": "8",
};

type GristRecord = { id: number; fields: Record<string, unknown> };

async function fetchRecords(o: GristOpts, table: string): Promise<GristRecord[]> {
  const url = `${o.baseUrl.replace(/\/$/, "")}/o/docs/api/docs/${encodeURIComponent(o.docId)}/tables/${encodeURIComponent(table)}/records`;
  const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${o.apiKey}` } });
  if (!res.ok) throw new Error(`Grist ${table}: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { records: GristRecord[] }).records;
}

async function listTables(o: GristOpts): Promise<string[]> {
  const url = `${o.baseUrl.replace(/\/$/, "")}/o/docs/api/docs/${encodeURIComponent(o.docId)}/tables`;
  const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${o.apiKey}` } });
  if (!res.ok) throw new Error(`Grist tables: HTTP ${res.status}`);
  return ((await res.json()) as { tables: { id: string }[] }).tables.map((t) => t.id);
}

const isoDate = (v: unknown) => (typeof v === "number" ? new Date(v * 1000).toISOString().slice(0, 10) : null);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function importFromGrist(db: DB, o: GristOpts) {
  const log = o.log ?? console.log;
  const [records, tables] = await Promise.all([fetchRecords(o, "Transactions"), listTables(o)]);
  const occTable = tables.find((t) => /occupancy/i.test(t));
  const occupancy = occTable ? await fetchRecords(o, occTable) : [];
  log(
    `Fetched ${records.length} transactions${occTable ? ` and ${occupancy.length} occupancy rows from ${occTable}` : ""}`,
  );

  // --- infer category definitions from the data ---
  const catStats = new Map<string, { direct: number; indirect: number; income: number; expense: number }>();
  for (const r of records) {
    const name = RENAME[str(r.fields.Category)] ?? str(r.fields.Category);
    if (!name) continue;
    const s = catStats.get(name) ?? { direct: 0, indirect: 0, income: 0, expense: 0 };
    const alloc = str(r.fields.Direct_or_Indirect).toLowerCase();
    if (alloc === "direct") s.direct++;
    if (alloc === "indirect") s.indirect++;
    if (str(r.fields.Category) === "Income") s.income++;
    else s.expense++;
    catStats.set(name, s);
  }

  const summary = {
    categories_created: [] as string[],
    created: 0,
    updated: 0,
    unchanged: 0,
    occupancy: 0,
    skipped: [] as string[],
  };

  const run = () => {
    // property: reuse by name, or adopt the untouched seeded default
    const existing = listProperties(db);
    const name = o.property ?? (existing.length === 1 ? existing[0]!.name : "My Rental");
    let property = existing.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!property) {
      const props = listProperties(db);
      const used = db.select({ n: count() }).from(transactions).get()!.n;
      if (props.length === 1 && props[0]!.name === "My Rental" && used === 0) {
        db.update(properties).set({ name }).where(eq(properties.id, props[0]!.id)).run();
        property = { ...props[0]!, name };
      } else {
        property = createProperty(db, null, { name });
      }
    }

    const cats = new Map<string, Category>(listCategories(db).map((c) => [c.name.toLowerCase(), c]));
    for (const [name, s] of catStats) {
      const kind = s.income > 0 ? "income" : "expense";
      const def = kind === "income" ? null : s.indirect > s.direct ? "indirect" : "direct";
      const existing = cats.get(name.toLowerCase());
      if (!existing) {
        cats.set(
          name.toLowerCase(),
          createCategory(db, null, { name, kind, default_allocation: def, schedule_e_line: SCHEDULE_E[name] ?? "19" }),
        );
        summary.categories_created.push(name);
      } else if (existing.archived) {
        db.update(categories).set({ archived: false }).where(eq(categories.id, existing.id)).run();
      }
    }
    // Hide the seeded "Platform Fees" when the document uses VRBO Fees instead and it is unused.
    if (catStats.has("VRBO Fees")) {
      db.update(categories)
        .set({ archived: true })
        .where(
          and(
            eq(categories.name, "Platform Fees"),
            notExists(
              db
                .select({ x: sql`1` })
                .from(transactions)
                .where(eq(transactions.categoryId, categories.id)),
            ),
          ),
        )
        .run();
    }

    for (const r of records) {
      const f = r.fields;
      const date = isoDate(f.Date);
      const catName = RENAME[str(f.Category)] ?? str(f.Category);
      const cat = cats.get(catName.toLowerCase());
      if (!date || !cat || typeof f.Amount !== "number") {
        summary.skipped.push(`row ${r.id}: missing date/category/amount`);
        continue;
      }
      const sub = str(f.Sub_Category);
      const notes = str(f.Notes);
      // Sub_Category is kept as-is (e.g. a manager's name under Management Fee), matching the Grist layout.
      const subcategory = sub;
      let vendor = "";
      let account = "";
      let reference = "";
      // "<Bank> CSV import: <bank text>" notes → account <Bank>, bank text as the reference
      const bankImport = notes.match(/^([A-Za-z][\w &.-]{0,40}?) CSV import:\s*(.*)$/i);
      if (bankImport) {
        account = bankImport[1]!;
        reference = bankImport[2]!;
      }
      if (cat.kind === "income" && !vendor) {
        if (/airbnb/i.test(notes)) vendor = "Airbnb";
        else if (/vrbo|homeaway|expedia/i.test(notes)) vendor = "VRBO";
      }
      const allocRaw = str(f.Direct_or_Indirect).toLowerCase();
      const allocation =
        cat.kind === "income"
          ? null
          : allocRaw === "direct" || allocRaw === "indirect"
            ? allocRaw
            : cat.default_allocation;
      const row = {
        date,
        amountCents: Math.round(f.Amount * 100),
        categoryId: cat.id,
        subcategory,
        vendor,
        allocation,
        description: bankImport ? "" : notes,
        account,
        reference,
      };
      const externalId = `grist:${o.docId}:${r.id}`;
      const existing = db.select().from(transactions).where(eq(transactions.externalId, externalId)).get();
      if (!existing) {
        db.insert(transactions)
          .values({ ...row, propertyId: property.id, source: "grist", externalId })
          .run();
        summary.created++;
      } else if ((Object.keys(row) as (keyof typeof row)[]).some((k) => existing[k] !== row[k])) {
        db.update(transactions)
          .set({ ...row, updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')` })
          .where(eq(transactions.id, existing.id))
          .run();
        summary.updated++;
      } else summary.unchanged++;
    }

    for (const r of occupancy) {
      const f = r.fields;
      const month = isoDate(f.Month)?.slice(0, 7);
      if (!month) continue;
      upsertOccupancy(db, null, {
        property_id: property.id,
        month,
        nights_available: typeof f.Nights_available === "number" ? f.Nights_available : null,
        nights_booked: Number(f.Nights_booked ?? 0),
        owner_nights: Number(f.Owner_stay_nights ?? 0),
        check_ins: Number(f.Total_check_ins ?? 0),
        notes: "Imported from Grist",
      });
      summary.occupancy++;
    }
    audit(db, null, "import", "grist", null, { doc: o.docId, ...summary, skipped: summary.skipped.length });
    if (o.dryRun) throw new DryRun();
  };

  try {
    tx(db, run);
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    log("Dry run: rolled back.");
  }
  return summary;
}

class DryRun extends Error {}
