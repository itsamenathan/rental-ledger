/**
 * Full backup as a .zip: a consistent snapshot of the SQLite database (VACUUM INTO, safe while the app is running)
 * plus every uploaded receipt. `restoreBackup` loads such a zip back into the running app.
 */
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.ts";
import { closeDb, migrationsFolder, openDb, setDb, tx, type DB } from "../db.ts";
import { apiKeys, sessions, users } from "../db/schema.ts";
import { AppError, audit, badRequest, requireAdmin, requireWrite, type Actor } from "../context.ts";
import { log } from "../telemetry.ts";
import { allStorageKeys } from "./storage.ts";

const README = `Rental Ledger backup

Contents
  rental.db   the whole database (transactions, categories, users, settings, audit log)
  uploads/    receipt files referenced by the database

Restore
  In the app: Settings → Backup → Restore from backup (admins). The current data is saved to
  backups/ in the data directory first. Sign-ins stay as they are on the server: current passwords,
  sessions and API keys are kept, and users who exist only in the backup come back disabled.

  By hand (brings back the backup's passwords, sessions and API keys as they were):
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
    // Receipts and manager documents may share stored files: put each file in the zip once.
    for (const key of allStorageKeys(db)) {
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

/** Read a ZIP produced by `zip` (or any ordinary zip tool: stored/deflate, no ZIP64). */
export function unzip(buf: Buffer): Entry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw badRequest("Not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Entry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw badRequest("Corrupt zip file");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (packedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff)
      throw badRequest("ZIP64 archives are not supported");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw badRequest("Corrupt zip file");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const packed = buf.subarray(start, start + packedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(packed);
    else if (method === 8) data = inflateRawSync(packed);
    else throw badRequest(`Unsupported compression in ${name}`);
    if (data.length !== size || crc32(data) !== crc) throw badRequest(`Corrupt zip entry ${name}`);
    out.push({ name, data });
  }
  return out;
}

/** Find rental.db and the receipts in a backup zip, allowing for a single wrapping folder. */
function readBackup(data: Buffer) {
  const entries = unzip(data).filter((e) => !e.name.startsWith("__MACOSX/"));
  const dbEntry = entries
    .filter((e) => e.name === "rental.db" || e.name.endsWith("/rental.db"))
    .sort((a, b) => a.name.length - b.name.length)[0];
  if (!dbEntry) throw badRequest("This zip has no rental.db; is it a Rental Ledger backup?");
  const prefix = dbEntry.name.slice(0, -"rental.db".length);
  const uploads: Entry[] = [];
  for (const e of entries) {
    if (!e.name.startsWith(prefix + "uploads/")) continue;
    const key = e.name.slice(prefix.length + "uploads/".length);
    const parts = key.split("/");
    if (!key || parts.some((s) => s === "" || s === "." || s === "..") || key.includes("\\"))
      throw badRequest(`Unsafe path in backup: ${e.name}`);
    uploads.push({ name: parts.join(sep), data: e.data });
  }
  return { db: dbEntry.data, uploads };
}

/** Open a candidate database read-only and make sure this app can use it. */
function checkDatabase(path: string) {
  let candidate: Database.Database;
  try {
    candidate = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    throw badRequest("rental.db in this backup is not a SQLite database");
  }
  try {
    const ok = candidate.pragma("integrity_check", { simple: true });
    if (ok !== "ok") throw badRequest(`rental.db failed its integrity check: ${String(ok)}`);
    const has = (t: string) =>
      candidate.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
    if (!has("__drizzle_migrations") || !has("transactions") || !has("users"))
      throw badRequest("rental.db in this backup is not a Rental Ledger database");
    const applied = (candidate.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
    const known = readdirSync(migrationsFolder).filter((f) => f.endsWith(".sql")).length;
    if (applied > known)
      throw badRequest("This backup was made by a newer version of the app. Upgrade the app, then restore.");
    const count = (t: string) => (candidate.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n;
    return { transactions: count("transactions") };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw badRequest(`rental.db in this backup could not be read: ${(e as Error).message}`);
  } finally {
    candidate.close();
  }
}

type UserRow = typeof users.$inferSelect;
type Logins = { users: UserRow[]; sessions: (typeof sessions.$inferSelect)[]; keys: (typeof apiKeys.$inferSelect)[] };

function readLogins(db: DB): Logins {
  return {
    users: db.select().from(users).all(),
    sessions: db.select().from(sessions).all(),
    keys: db.select().from(apiKeys).all(),
  };
}

/**
 * Sign-in state belongs to this server, not to the backup: restoring old data must not bring back a revoked API
 * key or an old password, or lock out whoever is restoring. User rows stay (history references their ids), but:
 *  - sessions and API keys are the current ones; the backup's are dropped;
 *  - a user in both (matched by email) keeps the backup's id, with the current password, role, SSO link and status;
 *  - a user only in the backup is restored disabled, for an admin to re-enable;
 *  - a user only on this server is kept, under a new id if theirs is taken.
 * A server with no users yet (fresh install restored from the CLI) takes the backup's logins unchanged.
 * Returns current user id → id in the restored database.
 */
function mergeLogins(target: DB, current: Logins) {
  const idMap = new Map<number, number>();
  const stats = { kept: 0, disabled: 0, added: 0 };
  if (!current.users.length) return { idMap, stats };
  tx(target, () => {
    target.delete(sessions).run();
    target.delete(apiKeys).run(); // audit entries that named a backup key keep the user, lose the key (SET NULL)
    const backupUsers = target.select().from(users).all();
    const byEmail = new Map(backupUsers.map((u) => [u.email.toLowerCase(), u]));
    const currentSubs = new Set(current.users.map((u) => u.oidcSub).filter(Boolean));
    target.update(users).set({ oidcSub: null }).run(); // oidc_sub is unique; reassigned below
    const matched = new Set<number>();
    const taken = new Set(backupUsers.map((u) => u.id));
    for (const c of current.users) {
      const b = byEmail.get(c.email.toLowerCase());
      const creds = {
        email: c.email,
        name: c.name,
        passwordHash: c.passwordHash,
        role: c.role,
        oidcSub: c.oidcSub,
        disabled: c.disabled,
      };
      if (b) {
        target.update(users).set(creds).where(eq(users.id, b.id)).run();
        idMap.set(c.id, b.id);
        matched.add(b.id);
        stats.kept++;
      } else {
        const free = !taken.has(c.id);
        const row = target
          .insert(users)
          .values({ ...creds, ...(free ? { id: c.id } : {}), createdAt: c.createdAt })
          .returning({ id: users.id })
          .get();
        idMap.set(c.id, row.id);
        taken.add(row.id);
        stats.added++;
      }
    }
    for (const b of backupUsers) {
      if (matched.has(b.id)) continue;
      const oidcSub = b.oidcSub && !currentSubs.has(b.oidcSub) ? b.oidcSub : null;
      target.update(users).set({ disabled: true, oidcSub }).where(eq(users.id, b.id)).run();
      stats.disabled++;
    }
    for (const s of current.sessions) {
      const userId = idMap.get(s.userId);
      if (userId)
        target
          .insert(sessions)
          .values({ ...s, userId })
          .run();
    }
    for (const k of current.keys) {
      const userId = idMap.get(k.userId);
      if (userId)
        target
          .insert(apiKeys)
          .values({ ...k, userId })
          .run();
    }
  });
  return { idMap, stats };
}

/**
 * Replace the whole database and receipts folder with a backup zip, in place, while the app keeps running.
 * The current data is first saved as a normal backup in `<data>/backups/`. Sign-in state (users' credentials,
 * sessions, API keys) is kept from the current database; see `mergeLogins`. All work happens on a staged copy;
 * the final swap is synchronous, so no request can see a half-restored state.
 */
export function restoreBackup(db: DB, actor: Actor | null, data: Buffer, source = "upload") {
  if (actor) {
    requireAdmin(actor);
    requireWrite(actor);
  }
  const backup = readBackup(data);
  const dbPath = db.$client.name === ":memory:" ? resolve(config.databasePath) : resolve(db.$client.name);
  const uploadsDir = resolve(config.uploadsDir);
  mkdirSync(dirname(dbPath), { recursive: true });
  const staged = `${dbPath}.restoring`;
  const stagedUploads = `${uploadsDir}.restoring`;
  const oldUploads = `${uploadsDir}.old`;
  for (const p of [staged, `${staged}-wal`, `${staged}-shm`, stagedUploads, oldUploads])
    rmSync(p, { recursive: true, force: true });
  try {
    writeFileSync(staged, backup.db);
    const counts = checkDatabase(staged);

    // Upgrade the staged copy to this app's schema and carry over the current logins, before touching live data.
    const target = openDb(staged);
    let merged: ReturnType<typeof mergeLogins>;
    try {
      merged = mergeLogins(target, readLogins(db));
    } finally {
      closeDb(target);
    }

    for (const u of backup.uploads) {
      const p = join(stagedUploads, u.name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, u.data);
    }

    // Safety net: keep the current data as a regular backup.
    const before = createBackup(db, actor);
    const backupsDir = join(config.dataDir, "backups");
    mkdirSync(backupsDir, { recursive: true });
    const savedAs = join(backupsDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
    writeFileSync(savedAs, before.data);

    // Swap. better-sqlite3 is synchronous, so nothing else runs until the new handle is installed.
    // Closing checkpoints the WAL; rename then atomically replaces the file. If that fails, reopen the original.
    db.$client.close();
    try {
      for (const p of [`${dbPath}-wal`, `${dbPath}-shm`]) rmSync(p, { force: true });
      renameSync(staged, dbPath);
    } catch (e) {
      setDb(openDb(dbPath));
      throw e;
    }
    if (existsSync(uploadsDir)) renameSync(uploadsDir, oldUploads);
    if (existsSync(stagedUploads)) renameSync(stagedUploads, uploadsDir);
    else mkdirSync(uploadsDir, { recursive: true });
    rmSync(oldUploads, { recursive: true, force: true });
    const restored = openDb(dbPath);
    setDb(restored);

    const result = {
      transactions: counts.transactions,
      receipts: backup.uploads.length,
      users_kept: merged.stats.kept,
      users_disabled: merged.stats.disabled,
      users_added: merged.stats.added,
      previous_data_saved_as: savedAs,
    };
    const newId = actor && merged.idMap.get(actor.user.id);
    audit(restored, newId ? { ...actor, user: { ...actor.user, id: newId } } : null, "restore", "backup", null, {
      source,
      ...result,
    });
    log.warn({ ...result, db: dbPath }, "database restored from backup");
    return result;
  } finally {
    for (const p of [staged, `${staged}-wal`, `${staged}-shm`, stagedUploads])
      rmSync(p, { recursive: true, force: true });
  }
}
