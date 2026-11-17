/**
 * Receipts uploaded from the entry form before the entry is saved. The form uploads a file as soon as it's picked
 * (`stageUpload`) and sends the ids with the save (`upload_ids` on create/update), which turns them into attachments in
 * the same database transaction as the entry: either the entry is saved with its receipts or nothing is kept. A form
 * closed without saving discards its uploads; anything left behind is pruned after `STALE_HOURS`.
 */
import { and, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { pendingUploads } from "../db/schema.ts";
import { audit, badRequest, requireWrite, type Actor } from "../context.ts";
import { attachStored } from "./attachments.ts";
import { checkUpload, cleanFilename, releaseFile, sha256, storeBytes } from "./storage.ts";

export const STALE_HOURS = 24;

export interface PendingUpload {
  id: number;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
}

const cols = {
  id: pendingUploads.id,
  filename: pendingUploads.filename,
  content_type: pendingUploads.contentType,
  size: pendingUploads.size,
  created_at: pendingUploads.createdAt,
};

export const uploadIds = z.array(z.number().int().positive()).max(50);

/** Store a receipt for an entry that hasn't been saved yet. */
export async function stageUpload(
  db: DB,
  actor: Actor,
  file: { filename: string; contentType: string; data: Uint8Array },
): Promise<PendingUpload> {
  requireWrite(actor);
  await pruneStaleUploads(db);
  const { contentType, ext } = checkUpload(file);
  const sha = sha256(file.data);
  const filename = cleanFilename(file.filename, `receipt.${ext}`);
  return storeBytes(
    db,
    file.data,
    ext,
    (key) =>
      tx(db, () => {
        const row = db
          .insert(pendingUploads)
          .values({
            filename,
            contentType,
            size: file.data.byteLength,
            sha256: sha,
            storageKey: key,
            createdBy: actor.user.id,
          })
          .returning(cols)
          .get();
        audit(db, actor, "create", "pending_upload", row.id, { filename, size: row.size });
        return row;
      }),
    sha,
  );
}

/** Drop uploads the caller made for a form that wasn't saved. Ids that are gone (already saved or discarded) are skipped. */
export async function discardUploads(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const ids = uploadIds.parse(raw);
  if (!ids.length) return { discarded: 0 };
  const rows = db
    .select({ id: pendingUploads.id, key: pendingUploads.storageKey, filename: pendingUploads.filename })
    .from(pendingUploads)
    .where(and(inArray(pendingUploads.id, ids), eq(pendingUploads.createdBy, actor.user.id)))
    .all();
  for (const r of rows) {
    db.delete(pendingUploads).where(eq(pendingUploads.id, r.id)).run();
    audit(db, actor, "delete", "pending_upload", r.id, { filename: r.filename });
    await releaseFile(db, r.key);
  }
  return { discarded: rows.length };
}

/**
 * Turn the caller's uploads into attachments of `transactionId`. Synchronous and database-only (the files are already
 * stored), so it runs inside the save's transaction. A file whose bytes are already on the entry is not added twice.
 */
export function claimUploads(db: DB, actor: Actor, transactionId: number, raw: unknown) {
  const ids = [...new Set(uploadIds.parse(raw))];
  if (!ids.length) return;
  const rows = db
    .select()
    .from(pendingUploads)
    .where(and(inArray(pendingUploads.id, ids), eq(pendingUploads.createdBy, actor.user.id)))
    .all();
  if (rows.length !== ids.length)
    throw badRequest("A receipt upload has expired or was removed. Add the receipt again, then save.");
  for (const r of rows) {
    db.delete(pendingUploads).where(eq(pendingUploads.id, r.id)).run();
    // A file whose bytes are already on the entry isn't added again; the stored file stays, that attachment uses it.
    attachStored(db, actor, transactionId, {
      filename: r.filename,
      contentType: r.contentType,
      size: r.size,
      sha256: r.sha256,
      storageKey: r.storageKey,
    });
  }
}

/** Remove uploads from forms that were abandoned without a discard (closed tab, lost connection). */
export async function pruneStaleUploads(db: DB, hours = STALE_HOURS) {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  const stale = db
    .select({ id: pendingUploads.id, key: pendingUploads.storageKey })
    .from(pendingUploads)
    .where(lt(pendingUploads.createdAt, cutoff))
    .all();
  for (const r of stale) {
    db.delete(pendingUploads).where(eq(pendingUploads.id, r.id)).run();
    audit(db, null, "delete", "pending_upload", r.id, { pruned: true });
    await releaseFile(db, r.key);
  }
  return stale.length;
}
