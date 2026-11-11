/**
 * Full backup as a .zip: a consistent snapshot of the SQLite database (VACUUM INTO, safe while the app is running)
 * plus every uploaded receipt. Restore by stopping the app and unzipping into the data directory.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { attachments } from "../db/schema.ts";
import { audit, requireAdmin, type Actor } from "../context.ts";

const README = `Rental Ledger backup

Contents
  rental.db   the whole database (transactions, categories, users, settings, audit log)
  uploads/    receipt files referenced by the database

Restore
  1. Stop the app.
  2. Unzip into the data directory (DATA_DIR, /data in Docker), replacing rental.db and uploads/.
     Delete any rental.db-wal / rental.db-shm files left next to the old database.
  3. Start the app. Newer app versions upgrade the database automatically.

The database contains password hashes and API key hashes; keep this file private.
`;

interface Entry {
  name: string;
  data: Buffer;
}

/** Minimal ZIP writer (deflate, UTF-8 names). Fine for backups well under 4 GB. */
export function zip(entries: Entry[], when = new Date()): Buffer {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const packed = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Build the backup zip. `actor` null = CLI. */
export function createBackup(db: DB, actor: Actor | null) {
  if (actor) requireAdmin(actor);
  const dir = mkdtempSync(join(tmpdir(), "rental-backup-"));
  try {
    const dbPath = join(dir, "rental.db");
    db.run(sql`VACUUM INTO ${dbPath}`);
    const entries: Entry[] = [
      { name: "README.txt", data: Buffer.from(README) },
      { name: "rental.db", data: readFileSync(dbPath) },
    ];
    const root = resolve(config.uploadsDir);
    const missing: string[] = [];
    for (const { key } of db.select({ key: attachments.storageKey }).from(attachments).all()) {
      const p = resolve(root, key);
      if (!p.startsWith(root + sep)) continue;
      if (existsSync(p)) entries.push({ name: `uploads/${key.split(sep).join("/")}`, data: readFileSync(p) });
      else missing.push(key);
    }
    const now = new Date();
    const file = zip(entries, now);
    audit(db, actor, "export", "backup", null, {
      bytes: file.length,
      receipts: entries.length - 2,
      missing_receipts: missing.length || undefined,
    });
    return {
      filename: `rental-ledger-backup-${now.toISOString().slice(0, 10)}.zip`,
      data: file,
      receipts: entries.length - 2,
      missing,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
