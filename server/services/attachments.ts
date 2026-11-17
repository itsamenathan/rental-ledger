import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { attachments } from "../db/schema.ts";
import { audit, notFound, requireWrite, type Actor } from "../context.ts";
import { getTransaction } from "./ledger.ts";
import { checkUpload, cleanFilename, readStored, releaseFile, sha256, storeBytes } from "./storage.ts";

export { ALLOWED, cleanFilename } from "./storage.ts";

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
  const { contentType, ext } = checkUpload(file);
  const sha = sha256(file.data);
  const filename = cleanFilename(file.filename, `receipt.${ext}`);
  // Same bytes stored for another entry (or a manager document): share that file instead of writing a second copy.
  const id = await storeBytes(
    db,
    file.data,
    ext,
    (key) =>
      attachStored(db, actor, transactionId, {
        filename,
        contentType,
        size: file.data.byteLength,
        sha256: sha,
        storageKey: key,
      }),
    sha,
  );
  const { storage_key: _k, ...meta } = getStored(db, id);
  return meta;
}

/**
 * Attach an already stored file to an entry and return the attachment id. Synchronous, so it can run inside a
 * caller's transaction. Same bytes already on the entry: that attachment's id, nothing added (uploads are idempotent).
 */
export function attachStored(
  db: DB,
  actor: Actor,
  transactionId: number,
  file: { filename: string; contentType: string; size: number; sha256: string; storageKey: string },
  details: Record<string, unknown> = {},
): number {
  return tx(db, () => {
    const sameHere = db
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(eq(attachments.transactionId, transactionId), eq(attachments.sha256, file.sha256)))
      .get();
    if (sameHere) return sameHere.id;
    const { id } = db
      .insert(attachments)
      .values({ transactionId, ...file, createdBy: actor.user.id })
      .returning({ id: attachments.id })
      .get();
    audit(db, actor, "create", "attachment", id, {
      transaction_id: transactionId,
      filename: file.filename,
      size: file.size,
      ...details,
    });
    return id;
  });
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

const attachmentPatch = z
  .object({
    filename: z.string().min(1).max(200).optional(),
    /** Move the file to another entry. */
    transaction_id: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Rename an attachment or move it to another entry. If the target entry already holds the same file, the moved row
 * is dropped instead of duplicated. Returns the attachment as it now stands (the existing one in that case).
 */
export async function updateAttachment(db: DB, actor: Actor, id: number, raw: unknown): Promise<Attachment> {
  requireWrite(actor);
  const patch = attachmentPatch.parse(raw);
  const row = getStored(db, id);
  const filename = patch.filename != null ? cleanFilename(patch.filename, row.filename) : row.filename;
  const target = patch.transaction_id ?? row.transaction_id;
  if (target !== row.transaction_id) getTransaction(db, target);

  const sha = db.select({ sha: attachments.sha256 }).from(attachments).where(eq(attachments.id, id)).get()!.sha;
  const already =
    target !== row.transaction_id
      ? db
          .select({ id: attachments.id })
          .from(attachments)
          .where(and(eq(attachments.transactionId, target), eq(attachments.sha256, sha), ne(attachments.id, id)))
          .get()
      : undefined;

  const changes: Record<string, [unknown, unknown]> = {};
  if (filename !== row.filename) changes.filename = [row.filename, filename];
  if (target !== row.transaction_id) changes.transaction_id = [row.transaction_id, target];
  if (!Object.keys(changes).length) {
    const { storage_key: _k, ...meta } = row;
    return meta;
  }

  if (already) {
    // Same bytes are already on the target entry: drop this copy (the stored file stays, the other row uses it).
    tx(db, () => {
      db.delete(attachments).where(eq(attachments.id, id)).run();
      audit(db, actor, "delete", "attachment", id, {
        transaction_id: row.transaction_id,
        filename: row.filename,
        merged_into: already.id,
      });
    });
    await releaseFile(db, row.storage_key);
    const { storage_key: _k, ...meta } = getStored(db, already.id);
    return meta;
  }

  tx(db, () => {
    db.update(attachments).set({ filename, transactionId: target }).where(eq(attachments.id, id)).run();
    audit(db, actor, "update", "attachment", id, changes);
  });
  const { storage_key: _k, ...meta } = getStored(db, id);
  return meta;
}

/**
 * Attach an existing file to another entry as well (one receipt covering several entries). The stored file is shared,
 * not copied. If the entry already holds the same file, that attachment is returned unchanged.
 */
export function linkAttachment(db: DB, actor: Actor, id: number, raw: unknown): Attachment {
  requireWrite(actor);
  const { transaction_id: target } = z.object({ transaction_id: z.number().int().positive() }).strict().parse(raw);
  const row = db.select().from(attachments).where(eq(attachments.id, id)).get();
  if (!row) throw notFound("Attachment");
  getTransaction(db, target);
  const already = db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.transactionId, target), eq(attachments.sha256, row.sha256)))
    .get();
  const newId =
    already?.id ??
    tx(db, () => {
      const { id: created } = db
        .insert(attachments)
        .values({
          transactionId: target,
          filename: row.filename,
          contentType: row.contentType,
          size: row.size,
          sha256: row.sha256,
          storageKey: row.storageKey,
          createdBy: actor.user.id,
        })
        .returning({ id: attachments.id })
        .get();
      audit(db, actor, "create", "attachment", created, {
        transaction_id: target,
        filename: row.filename,
        linked_from: id,
      });
      return created;
    });
  const { storage_key: _k, ...meta } = getStored(db, newId);
  return meta;
}
