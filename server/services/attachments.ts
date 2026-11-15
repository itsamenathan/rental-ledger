import { and, eq } from "drizzle-orm";
import type { DB } from "../db.ts";
import { attachments } from "../db/schema.ts";
import { config } from "../config.ts";
import { AppError, audit, badRequest, notFound, requireWrite, type Actor } from "../context.ts";
import { getTransaction } from "./ledger.ts";
import { readStored, releaseFile, sha256, storeBytes } from "./storage.ts";

export const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
};

export interface Attachment {
  id: number;
  transaction_id: number;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
}

const attachmentCols = {
  id: attachments.id,
  transaction_id: attachments.transactionId,
  filename: attachments.filename,
  content_type: attachments.contentType,
  size: attachments.size,
  created_at: attachments.createdAt,
};

export function listAttachments(db: DB, transactionId: number): Attachment[] {
  return db
    .select(attachmentCols)
    .from(attachments)
    .where(eq(attachments.transactionId, transactionId))
    .orderBy(attachments.id)
    .all();
}

function getStored(db: DB, id: number) {
  const row = db
    .select({ ...attachmentCols, storage_key: attachments.storageKey })
    .from(attachments)
    .where(eq(attachments.id, id))
    .get();
  if (!row) throw notFound("Attachment");
  return row;
}

export async function addAttachment(
  db: DB,
  actor: Actor,
  transactionId: number,
  file: { filename: string; contentType: string; data: Uint8Array },
): Promise<Attachment> {
  requireWrite(actor);
  getTransaction(db, transactionId);
  const contentType = file.contentType.split(";")[0]!.trim().toLowerCase();
  const ext = ALLOWED[contentType];
  if (!ext) throw badRequest(`Unsupported file type ${contentType}. Allowed: ${Object.keys(ALLOWED).join(", ")}`);
  if (file.data.byteLength === 0) throw badRequest("Empty file");
  if (file.data.byteLength > config.maxUploadBytes) throw new AppError(413, "File too large");
  const sha = sha256(file.data);
  // Same bytes already attached to this entry: nothing to add (uploads are idempotent).
  const sameHere = db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.transactionId, transactionId), eq(attachments.sha256, sha)))
    .get();
  if (sameHere) {
    const { storage_key: _k, ...meta } = getStored(db, sameHere.id);
    return meta;
  }
  // Same bytes stored for another entry (or a manager document): share that file instead of writing a second copy.
  const key = await storeBytes(db, file.data, ext, sha);
  const filename = file.filename.replace(/[\\/\r\n"]/g, "_").slice(0, 200) || `receipt.${ext}`;
  const { id } = db
    .insert(attachments)
    .values({
      transactionId,
      filename,
      contentType,
      size: file.data.byteLength,
      sha256: sha,
      storageKey: key,
      createdBy: actor.user.id,
    })
    .returning({ id: attachments.id })
    .get();
  audit(db, actor, "create", "attachment", id, { transaction_id: transactionId, filename, size: file.data.byteLength });
  const { storage_key: _k, ...meta } = getStored(db, id);
  return meta;
}

export async function readAttachment(db: DB, id: number) {
  const row = getStored(db, id);
  return { meta: row, data: await readStored(row.storage_key) };
}

export async function deleteAttachment(db: DB, actor: Actor, id: number) {
  requireWrite(actor);
  const row = getStored(db, id);
  db.delete(attachments).where(eq(attachments.id, id)).run();
  // The stored file may be shared with other entries or manager documents; only remove it with its last reference.
  await releaseFile(db, row.storage_key);
  audit(db, actor, "delete", "attachment", id, { transaction_id: row.transaction_id, filename: row.filename });
}
