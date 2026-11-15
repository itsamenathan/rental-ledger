/**
 * Saving the manager's paperwork: each uploaded owner-statement CSV or invoice is kept (file + its text) under the
 * month it covers, so any month can be re-checked later. Kind and month are detected from the content.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db.ts";
import { managerDocuments } from "../db/schema.ts";
import { audit, badRequest, notFound, requireWrite, type Actor } from "../context.ts";
import { log } from "../telemetry.ts";
import { addAttachment } from "./attachments.ts";
import { extractPdfText } from "./invoice-pdf.ts";
import { resolvePropertyId } from "./ledger.ts";
import {
  applyManagerMonth,
  invoiceMonth,
  listDocuments,
  managerContext,
  parseInvoiceText,
  parseStatementCsv,
  statementMonth,
  type ParsedStatement,
  type SavedDoc,
} from "./manager-statement.ts";
import { readStored, releaseFile, sha256, storeBytes } from "./storage.ts";

export interface UploadFile {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface SaveResult {
  filename: string;
  status: "saved" | "replaced" | "duplicate" | "conflict" | "error";
  message: string;
  document?: SavedDoc;
  /** For a conflict: the saved document this one would replace. */
  existing?: SavedDoc;
}

const isPdf = (f: UploadFile) =>
  f.contentType === "application/pdf" ||
  /\.pdf$/i.test(f.filename) ||
  new TextDecoder().decode(f.data.subarray(0, 5)) === "%PDF-";

interface Prepared {
  file: UploadFile;
  sha: string;
  kind: "statement" | "invoice";
  text: string;
  statement?: ParsedStatement;
  invoice?: ReturnType<typeof parseInvoiceText>;
}

async function prepare(f: UploadFile): Promise<Prepared> {
  if (!f.data.byteLength) throw badRequest("Empty file");
  const sha = sha256(f.data);
  if (isPdf(f)) {
    const text = await extractPdfText(f.data);
    return { file: f, sha, kind: "invoice", text, invoice: parseInvoiceText(text) };
  }
  const text = new TextDecoder().decode(f.data);
  try {
    return { file: f, sha, kind: "statement", text, statement: parseStatementCsv(text) };
  } catch (statementErr) {
    try {
      return { file: f, sha, kind: "invoice", text, invoice: parseInvoiceText(text) };
    } catch {
      throw statementErr;
    }
  }
}

const docSelect = (db: DB, id: number) => {
  const d = db.select().from(managerDocuments).where(eq(managerDocuments.id, id)).get();
  if (!d) throw notFound("Document");
  return d;
};
const toView = (db: DB, propertyId: number, id: number) => listDocuments(db, propertyId).find((d) => d.id === id)!;

const label = (kind: string, month: string, reference = "") =>
  `${kind === "statement" ? "Owner statement" : `Invoice${reference ? ` ${reference}` : ""}`} for ${month}`;

/**
 * Save uploaded statements and invoices. Statements are handled first so an invoice can be placed by matching its
 * management fee to a statement. Identical files are skipped; a different file for an occupied slot (the month's
 * statement, or an invoice with the same number) is a conflict unless `replace` is set.
 */
export async function saveDocuments(
  db: DB,
  actor: Actor,
  files: UploadFile[],
  opts: { property?: number | string; replace?: boolean; month?: string } = {},
): Promise<SaveResult[]> {
  requireWrite(actor);
  const propertyId = resolvePropertyId(db, opts.property);
  if (opts.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) throw badRequest("Use YYYY-MM for month");
  const results: SaveResult[] = [];
  const prepared: Prepared[] = [];
  for (const f of files) {
    try {
      prepared.push(await prepare(f));
    } catch (e) {
      log.warn({ err: e, filename: f.filename }, "manager document not recognized");
      results.push({
        filename: f.filename,
        status: "error",
        message: `Not recognized as an owner statement or invoice: ${(e as Error).message}`,
      });
    }
  }
  prepared.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "statement" ? -1 : 1));

  for (const p of prepared) {
    const { file } = p;
    const dup = db
      .select({ id: managerDocuments.id })
      .from(managerDocuments)
      .where(and(eq(managerDocuments.propertyId, propertyId), eq(managerDocuments.sha256, p.sha)))
      .get();
    if (dup) {
      const existing = toView(db, propertyId, dup.id);
      results.push({
        filename: file.filename,
        status: "duplicate",
        message: `Already saved (${label(existing.kind, existing.month, existing.reference)})`,
        document: existing,
      });
      continue;
    }
    const statements = managerContext(db, propertyId).statements;
    const month =
      opts.month ?? (p.statement ? statementMonth(p.statement) : (invoiceMonth(p.invoice!, statements) ?? null));
    if (!month) {
      results.push({ filename: file.filename, status: "error", message: "Couldn't tell which month this covers" });
      continue;
    }
    const reference = p.invoice?.number ?? "";
    const occupied = listDocuments(db, propertyId, { month }).filter(
      (d) => d.kind === p.kind && (p.kind === "statement" || (reference !== "" && d.reference === reference)),
    );
    if (occupied.length && !opts.replace) {
      results.push({
        filename: file.filename,
        status: "conflict",
        message: `${label(p.kind, month, reference)} is already saved as "${occupied[0]!.filename}". Replace it?`,
        existing: occupied[0],
      });
      continue;
    }
    for (const old of occupied) await deleteDocument(db, actor, old.id);
    const ext = isPdf(file) ? "pdf" : p.kind === "statement" ? "csv" : "txt";
    const key = await storeBytes(db, file.data, ext, p.sha);
    const contentType = isPdf(file) ? "application/pdf" : p.kind === "statement" ? "text/csv" : "text/plain";
    const { id } = db
      .insert(managerDocuments)
      .values({
        propertyId,
        month,
        kind: p.kind,
        filename: file.filename.replace(/[\\/\r\n"]/g, "_").slice(0, 200) || `${p.kind}.${ext}`,
        contentType,
        size: file.data.byteLength,
        sha256: p.sha,
        storageKey: key,
        text: p.text,
        reference,
        createdBy: actor.user.id,
      })
      .returning({ id: managerDocuments.id })
      .get();
    audit(db, actor, "create", "manager_document", id, { month, kind: p.kind, filename: file.filename, reference });
    results.push({
      filename: file.filename,
      status: occupied.length ? "replaced" : "saved",
      message: `Saved as the ${label(p.kind, month, reference).replace(/^\w/, (c) => c.toLowerCase())}`,
      document: toView(db, propertyId, id),
    });
  }
  return results;
}

export const documentPatch = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM"),
});

/** Move a document to another month (when detection got it wrong). */
export function updateDocument(db: DB, actor: Actor, id: number, raw: unknown) {
  requireWrite(actor);
  const { month } = documentPatch.parse(raw);
  const before = docSelect(db, id);
  db.update(managerDocuments).set({ month }).where(eq(managerDocuments.id, id)).run();
  audit(db, actor, "update", "manager_document", id, { month: [before.month, month] });
  return toView(db, before.propertyId, id);
}

export async function deleteDocument(db: DB, actor: Actor, id: number) {
  requireWrite(actor);
  const d = docSelect(db, id);
  db.delete(managerDocuments).where(eq(managerDocuments.id, id)).run();
  await releaseFile(db, d.storageKey);
  audit(db, actor, "delete", "manager_document", id, { month: d.month, kind: d.kind, filename: d.filename });
  return { id, deleted: true };
}

export async function readDocument(db: DB, id: number) {
  const d = docSelect(db, id);
  return {
    meta: { filename: d.filename, content_type: d.contentType },
    data: await readStored(d.storageKey),
  };
}

/**
 * Apply a month from its saved documents, then keep the paperwork with the books: each invoice is attached to the
 * entries for its lines, and the statement to the management-fee entry. Identical files share storage.
 */
export async function applySavedMonth(db: DB, actor: Actor, raw: Record<string, unknown> & { attach?: boolean }) {
  const { attach = true, ...rest } = raw;
  const result = applyManagerMonth(db, actor, rest);
  const attached: number[] = [];
  if (attach) {
    const propertyId = resolvePropertyId(db, (rest.property_id ?? rest.property) as number | string | undefined);
    const docs = listDocuments(db, propertyId, { month: result.month });
    const targets: [number, number][] = []; // [documentId, transactionId]
    for (const lt of result.line_transactions) if (lt.document_id) targets.push([lt.document_id, lt.transaction_id]);
    const statement = docs.filter((d) => d.kind === "statement").at(-1);
    if (statement && result.anchor_transaction_id) targets.push([statement.id, result.anchor_transaction_id]);
    const cache = new Map<number, { filename: string; contentType: string; data: Uint8Array }>();
    for (const [docId, txId] of targets) {
      let file = cache.get(docId);
      if (!file) {
        const d = await readDocument(db, docId);
        file = { filename: d.meta.filename, contentType: d.meta.content_type, data: new Uint8Array(d.data) };
        cache.set(docId, file);
      }
      // addAttachment ignores the same bytes already on the entry and reuses the stored file.
      const a = await addAttachment(db, actor, txId, file);
      attached.push(a.id);
    }
  }
  return { ...result, attachments: [...new Set(attached)].length };
}
