/**
 * Stored files (receipts and manager paperwork) in the uploads folder. Identical bytes are written once and shared by
 * every row that holds them, in `attachments`, `manager_documents` and `pending_uploads` alike, so a file is only
 * removed with its last reference in any of them.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import type { DB } from "../db.ts";
import { attachments, managerDocuments, pendingUploads } from "../db/schema.ts";
import { config } from "../config.ts";
import { AppError, badRequest } from "../context.ts";

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

/** A filename that is safe in a Content-Disposition header and a zip. */
export const cleanFilename = (name: string, fallback: string) =>
  name
    .replace(/[\\/\r\n"]/g, "_")
    .trim()
    .slice(0, 200) || fallback;

/** Validate an uploaded receipt: an allowed type, not empty, not over the size limit. */
export function checkUpload(file: { contentType: string; data: Uint8Array }) {
  const contentType = file.contentType.split(";")[0]!.trim().toLowerCase();
  const ext = ALLOWED[contentType];
  if (!ext) throw badRequest(`Unsupported file type ${contentType}. Allowed: ${Object.keys(ALLOWED).join(", ")}`);
  if (file.data.byteLength === 0) throw badRequest("Empty file");
  if (file.data.byteLength > config.maxUploadBytes) throw new AppError(413, "File too large");
  return { contentType, ext };
}

export function pathFor(key: string) {
  const root = resolve(config.uploadsDir);
  const p = resolve(root, key);
  if (!p.startsWith(root + sep)) throw new AppError(400, "Invalid storage key");
  return p;
}

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Every storage key referenced by any table (for backups). */
export function allStorageKeys(db: DB): string[] {
  const keys = new Set<string>();
  for (const r of db.selectDistinct({ key: attachments.storageKey }).from(attachments).all()) keys.add(r.key);
  for (const r of db.selectDistinct({ key: managerDocuments.storageKey }).from(managerDocuments).all()) keys.add(r.key);
  for (const r of db.selectDistinct({ key: pendingUploads.storageKey }).from(pendingUploads).all()) keys.add(r.key);
  return [...keys];
}

/** An existing stored file with these bytes, from any table. */
function existingKey(db: DB, sha: string): string | undefined {
  const rows = [
    ...db.select({ key: attachments.storageKey }).from(attachments).where(eq(attachments.sha256, sha)).all(),
    ...db
      .select({ key: managerDocuments.storageKey })
      .from(managerDocuments)
      .where(eq(managerDocuments.sha256, sha))
      .all(),
    ...db.select({ key: pendingUploads.storageKey }).from(pendingUploads).where(eq(pendingUploads.sha256, sha)).all(),
  ];
  return rows.find((r) => existsSync(pathFor(r.key)))?.key;
}

/** Store bytes (or reuse the identical stored file) and return its key. */
export async function storeBytes(db: DB, data: Uint8Array, ext: string, sha = sha256(data)): Promise<string> {
  const reuse = existingKey(db, sha);
  if (reuse) return reuse;
  const key = join(new Date().toISOString().slice(0, 7), `${randomBytes(12).toString("hex")}.${ext}`);
  const path = pathFor(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return key;
}

export const readStored = (key: string) => readFile(pathFor(key));

/** Call after deleting a row that pointed at `key`: removes the file once nothing references it. */
export async function releaseFile(db: DB, key: string) {
  const used =
    db.select({ id: attachments.id }).from(attachments).where(eq(attachments.storageKey, key)).get() ??
    db.select({ id: managerDocuments.id }).from(managerDocuments).where(eq(managerDocuments.storageKey, key)).get() ??
    db.select({ id: pendingUploads.id }).from(pendingUploads).where(eq(pendingUploads.storageKey, key)).get();
  if (!used) await unlink(pathFor(key)).catch(() => {});
}
