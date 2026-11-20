/**
 * The file library: every stored file (receipts on entries and the manager's statements/invoices) for a month or a
 * year, with the entries each one is attached to. One stored file is one item even when several rows point at it
 * (the manager statement is usually attached to many entries), so nothing is listed or zipped twice.
 *
 * A receipt belongs to the month of its entry's date; manager paperwork to the month it covers. Upload dates don't
 * matter. Entries in the trash are left out.
 */
import { existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { and, asc, count, eq, inArray, isNull, like, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { attachments, categories, filePreviews, managerDocuments, properties, transactions } from "../db/schema.ts";
import { audit, badRequest, type Actor } from "../context.ts";
import { RECEIPT_MIN_DOLLARS } from "./receipts.ts";
import { gatedZipStream, type ZipSource } from "./zip.ts";
import { listTransactions, type Transaction } from "./ledger.ts";

export const fileQuery = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    property_id: z.coerce.number().int().optional(),
    /** Matches file name, vendor, category, subcategory, description, reference */
    q: z.string().optional(),
    source: z.enum(["all", "receipts", "manager"]).default("all"),
  })
  .refine((v) => !(v.month && v.year), { message: "Pass month or year, not both" });
export type FileQuery = z.input<typeof fileQuery>;

export interface FileLink {
  attachment_id: number;
  transaction_id: number;
  date: string;
  amount: number;
  category: string;
  kind: "income" | "expense";
  vendor: string;
  subcategory: string;
  description: string;
  property: string;
}

export interface LibraryFile {
  /** Stable id for the stored file (its sha256). */
  key: string;
  filename: string;
  content_type: string;
  size: number;
  uploaded_at: string;
  /** Month the file belongs to (YYYY-MM). */
  month: string;
  /** Sort date: the first linked entry's date, or the first of the month for manager paperwork. */
  date: string;
  /** Open/download this URL (add ?download to force a download). */
  url: string;
  /** A picture of a file that isn't an image (a scanned PDF's first page), when one was saved with it. */
  preview_url: string | null;
  /** Set when the file is a saved manager statement or invoice. */
  manager: { id: number; kind: "statement" | "invoice"; month: string; reference: string; property: string } | null;
  /** Entries in this period the file is attached to. */
  links: FileLink[];
  /**
   * Other things that keep this file stored: attachments not listed above (entries in other periods or in the trash)
   * plus a saved manager document. 0 means unlinking the last listed entry deletes the file.
   */
  other_uses: number;
}

export interface FileLibrary {
  period: { month: string | null; year: number };
  files: LibraryFile[];
  totals: { files: number; bytes: number; receipts: number; manager: number };
  /** Expenses over the threshold in this period with no file attached (empty when source = manager). */
  missing: Transaction[];
  missing_total: number;
  receipt_min: number;
}

function period(q: z.output<typeof fileQuery>) {
  if (q.month) return { month: q.month, year: Number(q.month.slice(0, 4)), prefix: q.month };
  const year = q.year ?? new Date().getFullYear();
  return { month: null, year, prefix: String(year) };
}

const matches = (f: LibraryFile, needle: string) =>
  [
    f.filename,
    f.manager?.kind,
    f.manager?.reference,
    ...f.links.flatMap((l) => [l.vendor, l.category, l.subcategory, l.description, l.property]),
  ].some((s) => s?.toLowerCase().includes(needle));

export function listFiles(db: DB, raw: unknown): FileLibrary {
  const q = fileQuery.parse(raw);
  const p = period(q);
  const t = transactions;
  const byKey = new Map<string, LibraryFile>();

  if (q.source !== "manager") {
    const where: (SQL | undefined)[] = [isNull(t.deletedAt), like(t.date, `${p.prefix}-%`)];
    if (q.property_id) where.push(eq(t.propertyId, q.property_id));
    const rows = db
      .select({
        id: attachments.id,
        filename: attachments.filename,
        content_type: attachments.contentType,
        size: attachments.size,
        sha: attachments.sha256,
        created_at: attachments.createdAt,
        has_preview: sql<number>`${filePreviews.sha256} is not null`,
        transaction_id: t.id,
        date: t.date,
        amount: t.amountCents,
        category: categories.name,
        kind: categories.kind,
        vendor: t.vendor,
        subcategory: t.subcategory,
        description: t.description,
        property: properties.name,
      })
      .from(attachments)
      .leftJoin(filePreviews, eq(filePreviews.sha256, attachments.sha256))
      .innerJoin(t, eq(t.id, attachments.transactionId))
      .innerJoin(categories, eq(categories.id, t.categoryId))
      .innerJoin(properties, eq(properties.id, t.propertyId))
      .where(and(...where))
      .orderBy(asc(t.date), asc(t.id), asc(attachments.id))
      .all();
    for (const r of rows) {
      let f = byKey.get(r.sha);
      if (!f) {
        f = {
          key: r.sha,
          filename: r.filename,
          content_type: r.content_type,
          size: r.size,
          uploaded_at: r.created_at,
          month: r.date.slice(0, 7),
          date: r.date,
          url: `/api/attachments/${r.id}`,
          preview_url: r.has_preview ? `/api/attachments/${r.id}/preview` : null,
          manager: null,
          links: [],
          other_uses: 0,
        };
        byKey.set(r.sha, f);
      }
      f.links.push({
        attachment_id: r.id,
        transaction_id: r.transaction_id,
        date: r.date,
        amount: r.amount / 100,
        category: r.category,
        kind: r.kind,
        vendor: r.vendor,
        subcategory: r.subcategory,
        description: r.description,
        property: r.property,
      });
    }
  }

  // Manager paperwork: listed under the month it covers, and used to label receipts that are the same file.
  const docWhere: (SQL | undefined)[] = [];
  if (q.property_id) docWhere.push(eq(managerDocuments.propertyId, q.property_id));
  const docs = db
    .select({
      id: managerDocuments.id,
      month: managerDocuments.month,
      kind: managerDocuments.kind,
      reference: managerDocuments.reference,
      filename: managerDocuments.filename,
      content_type: managerDocuments.contentType,
      size: managerDocuments.size,
      sha: managerDocuments.sha256,
      created_at: managerDocuments.createdAt,
      property: properties.name,
    })
    .from(managerDocuments)
    .innerJoin(properties, eq(properties.id, managerDocuments.propertyId))
    .where(and(...docWhere))
    .orderBy(asc(managerDocuments.month), asc(managerDocuments.id))
    .all();
  for (const d of docs) {
    const manager = { id: d.id, kind: d.kind, month: d.month, reference: d.reference, property: d.property };
    const url = `/api/manager/documents/${d.id}/file`;
    const existing = byKey.get(d.sha);
    if (existing) {
      // A receipt that is a saved manager document: label it as such and file it under the month it covers.
      if (!existing.manager)
        Object.assign(existing, { manager, url, filename: d.filename, month: d.month, date: `${d.month}-01` });
      continue;
    }
    if (q.source === "receipts" || !d.month.startsWith(p.prefix)) continue;
    byKey.set(d.sha, {
      key: d.sha,
      filename: d.filename,
      content_type: d.content_type,
      size: d.size,
      uploaded_at: d.created_at,
      month: d.month,
      date: `${d.month}-01`,
      url,
      preview_url: null,
      manager,
      links: [],
      other_uses: 0,
    });
  }

  // How many attachments each file has in total, to tell whether unlinking the last listed entry deletes it.
  const shas = [...byKey.keys()];
  const totals = new Map<string, number>();
  for (let i = 0; i < shas.length; i += 500) {
    const part = shas.slice(i, i + 500);
    for (const r of db
      .select({ sha: attachments.sha256, n: count() })
      .from(attachments)
      .where(inArray(attachments.sha256, part))
      .groupBy(attachments.sha256)
      .all())
      totals.set(r.sha, r.n);
  }
  for (const f of byKey.values()) f.other_uses = (totals.get(f.key) ?? 0) - f.links.length + (f.manager ? 1 : 0);

  let files = [...byKey.values()];
  if (q.source === "receipts") files = files.filter((f) => !f.manager);
  if (q.source === "manager") files = files.filter((f) => f.manager);
  const needle = q.q?.trim().toLowerCase();
  if (needle) files = files.filter((f) => matches(f, needle));
  // Manager paperwork first within its month, then receipts by entry date.
  files.sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      Number(!a.manager) - Number(!b.manager) ||
      a.date.localeCompare(b.date) ||
      a.filename.localeCompare(b.filename),
  );

  const missing =
    q.source === "manager"
      ? { items: [] as Transaction[], total: 0 }
      : listTransactions(db, {
          ...(p.month ? { month: p.month } : { year: p.year }),
          property_id: q.property_id,
          q: q.q,
          needs_receipt: true,
          sort: "date_asc",
          limit: 500,
        });

  return {
    period: { month: p.month, year: p.year },
    files,
    totals: {
      files: files.length,
      bytes: files.reduce((s, f) => s + f.size, 0),
      receipts: files.filter((f) => !f.manager).length,
      manager: files.filter((f) => f.manager).length,
    },
    missing: missing.items,
    missing_total: missing.total,
    /** the default threshold; categories can override it or ask always/never (services/receipts.ts) */
    receipt_min: RECEIPT_MIN_DOLLARS,
  };
}

const safe = (s: string) =>
  s
    .replace(/[^\w .&()$,-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Name of a file inside the zip, e.g. "2026-10/2026-10-03 - Hardware Store - 123.45.pdf". */
function zipName(f: LibraryFile, folders: boolean) {
  const ext = extname(f.filename) || "";
  let base: string;
  if (f.manager) {
    const kind = f.manager.kind === "statement" ? "Manager statement" : "Manager invoice";
    base = `${f.manager.month} - ${kind}${f.manager.reference ? ` ${safe(f.manager.reference)}` : ""}`;
  } else {
    const l = f.links[0]!;
    const who = safe(l.vendor || l.subcategory || l.description || l.category) || "entry";
    const more = f.links.length > 1 ? ` (+${f.links.length - 1})` : "";
    base = `${l.date} - ${who} - ${Math.abs(l.amount).toFixed(2)}${more}`;
  }
  return { base: `${folders ? `${f.month}/` : ""}${base.slice(0, 150)}`, ext };
}

/** Every listed file in one zip, named by date, vendor and amount. */
export function filesZip(db: DB, actor: Actor | null, raw: unknown) {
  const lib = listFiles(db, raw);
  if (!lib.files.length) throw badRequest("No files in this period");
  const root = resolve(config.uploadsDir);
  const keys = new Map(
    [
      ...db.select({ sha: attachments.sha256, key: attachments.storageKey }).from(attachments).all(),
      ...db.select({ sha: managerDocuments.sha256, key: managerDocuments.storageKey }).from(managerDocuments).all(),
    ].map((r) => [r.sha, r.key]),
  );
  const used = new Set<string>();
  const entries: ZipSource[] = [];
  const missing: string[] = [];
  for (const f of lib.files) {
    const key = keys.get(f.key);
    const path = key ? resolve(root, key) : "";
    if (!key || !path.startsWith(root + sep) || !existsSync(path)) {
      missing.push(f.filename);
      continue;
    }
    const { base, ext } = zipName(f, !lib.period.month);
    let name = `${base}${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}${ext}`;
    used.add(name.toLowerCase());
    entries.push({ name, path });
  }
  const label = lib.period.month ?? String(lib.period.year);
  audit(db, actor, "export", "files", null, {
    period: label,
    files: entries.length,
    missing: missing.length || undefined,
  });
  return { filename: `Files ${label}.zip`, stream: gatedZipStream(entries).stream, files: entries.length, missing };
}
