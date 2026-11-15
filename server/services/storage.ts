/**
 * Stored files (receipts and manager paperwork) in the uploads folder. Identical bytes are written once and shared by
 * every row that holds them, in `attachments` and `manager_documents` alike, so a file is only removed with its last
 * reference in either table.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import type { DB } from "../db.ts";
import { attachments, managerDocuments } from "../db/schema.ts";
import { config } from "../config.ts";
import { AppError } from "../context.ts";

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
  return [...keys];
}

/** An existing stored file with these bytes, from either table. */
function existingKey(db: DB, sha: string): string | undefined {
  const rows = [
    ...db.select({ key: attachments.storageKey }).from(attachments).where(eq(attachments.sha256, sha)).all(),
    ...db
      .select({ key: managerDocuments.storageKey })
      .from(managerDocuments)
      .where(eq(managerDocuments.sha256, sha))
      .all(),
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
    db.select({ id: managerDocuments.id }).from(managerDocuments).where(eq(managerDocuments.storageKey, key)).get();
  if (!used) await unlink(pathFor(key)).catch(() => {});
}
