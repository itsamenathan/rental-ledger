/**
 * Full backup as a .zip: a consistent snapshot of the SQLite database (VACUUM INTO, safe while the app is running)
 * plus every uploaded receipt. `restoreBackup` loads such a zip back into the running app.
 */
import Database from "better-sqlite3";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq, inArray } from "drizzle-orm";
import { config } from "../config.ts";
import { closeDb, getDb, migrationsFolder, openDb, setDb, tx, type DB } from "../db.ts";
import { enter, exclusive } from "../maintenance.ts";
import { apiKeys, memberships, portfolios, sessions, users } from "../db/schema.ts";
import { AppError, audit, badRequest, requireInstanceAdmin, type Actor } from "../context.ts";
import { log } from "../telemetry.ts";
import { allStorageKeys } from "./storage.ts";
import { readZip, zipStream, type ZipEntry, type ZipSource } from "./zip.ts";

const README = `Rental Ledger backup

Contents
  rental.db   the whole database (transactions, categories, users, settings, audit log)
  uploads/    receipt files referenced by the database

Restore
  In the app: Settings → Server → Backup & restore (the server's administrator). The current data is saved to
  backups/ in the data directory first. Sign-ins stay as they are on the server: current passwords,
  sessions and API keys are kept, and users who exist only in the backup come back disabled.

  By hand (brings back the backup's passwords, sessions and API keys as they were):
  1. Stop the app.
  2. Unzip into the data directory (DATA_DIR, /data in Docker), replacing rental.db and uploads/.
     Delete any rental.db-wal / rental.db-shm files left next to the old database.
  3. Start the app. Newer app versions upgrade the database automatically.

The database contains password hashes and API key hashes; keep this file private.
`;

export { unzip, zip } from "./zip.ts";

/** Restored entries may inflate to at most this many bytes in all (disk, not memory: entries are written one by one). */
const maxRestoredBytes = () => Math.max(config.maxRestoreBytes * 4, 1024 * 1024 * 1024);

/**
 * Stream the backup zip. `actor` null = CLI. The database snapshot uses SQLite's online backup, which copies in steps
 * between other work, and is only taken once someone reads the stream. `gated: false` is for the restore's own
 * safety copy, taken while the maintenance gate is closed.
 */
export function createBackup(db: DB, actor: Actor | null, opts: { gated?: boolean } = {}) {
  if (actor) requireInstanceAdmin(actor);
  const now = new Date();
  const root = resolve(config.uploadsDir);
  let dir = "";
  let release: (() => void) | undefined;
  const keys = allStorageKeys(db);
  async function* sources(): AsyncGenerator<ZipSource> {
    yield { name: "README.txt", data: Buffer.from(README) };
    const dbPath = join(dir, "rental.db");
    await db.$client.backup(dbPath);
    yield { name: "rental.db", path: dbPath };
    // Receipts and manager documents may share stored files: put each file in the zip once.
    for (const key of keys) {
      const p = resolve(root, key);
      if (p.startsWith(root + sep)) yield { name: `uploads/${key.split(sep).join("/")}`, path: p };
    }
  }
  const z = zipStream(sources, {
    when: now,
    open: async () => {
      if (opts.gated !== false) release = enter();
      dir = await mkdtemp(join(tmpdir(), "rental-backup-"));
    },
    close: async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
      release?.();
    },
  });
  // Audited up front, like every export: rental.db holds password and API key hashes, and a download cancelled part
  // way has still handed some of it out.
  audit(db, actor, "export", "backup", null, { receipts: keys.length });
  const done = z.done.then((r) => {
    const missing = r.missing.map((name) => name.replace(/^uploads\//, ""));
    log.info({ bytes: r.bytes, receipts: r.files - 2, missing: missing.length }, "backup written");
    return { bytes: r.bytes, receipts: r.files - 2, missing };
  });
  done.catch(() => {});
  return { filename: backupFilename(now), stream: z.stream, done };
}

export const backupFilename = (when = new Date()) => `rental-ledger-backup-${when.toISOString().slice(0, 10)}.zip`;

/** Write a backup zip to a file and wait for it. */
export async function writeBackup(db: DB, actor: Actor | null, path: string, opts: { gated?: boolean } = {}) {
  const b = createBackup(db, actor, opts);
  await pipeline(Readable.fromWeb(b.stream as never), createWriteStream(path));
  return b.done;
}

/** Find rental.db and the receipts in a backup zip, allowing for a single wrapping folder. Nothing is inflated yet. */
function readBackup(data: Buffer) {
  const entries = readZip(data).filter((e) => !e.name.startsWith("__MACOSX/"));
  const dbEntry = entries
    .filter((e) => e.name === "rental.db" || e.name.endsWith("/rental.db"))
    .sort((a, b) => a.name.length - b.name.length)[0];
  if (!dbEntry) throw badRequest("This zip has no rental.db; is it a Rental Ledger backup?");
  const prefix = dbEntry.name.slice(0, -"rental.db".length);
  const uploads: { key: string; entry: ZipEntry }[] = [];
  for (const e of entries) {
    if (!e.name.startsWith(prefix + "uploads/")) continue;
    const key = e.name.slice(prefix.length + "uploads/".length);
    const parts = key.split("/");
    if (!key || parts.some((s) => s === "" || s === "." || s === "..") || key.includes("\\"))
      throw badRequest(`Unsafe path in backup: ${e.name}`);
    uploads.push({ key: parts.join(sep), entry: e });
  }
  const total = dbEntry.size + uploads.reduce((n, u) => n + u.entry.size, 0);
  if (total > maxRestoredBytes()) throw new AppError(413, "This backup unpacks to more than the restore limit");
  return { db: dbEntry, uploads };
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
type Logins = {
  users: UserRow[];
  sessions: (typeof sessions.$inferSelect)[];
  keys: (typeof apiKeys.$inferSelect)[];
  memberships: (typeof memberships.$inferSelect)[];
};

function readLogins(db: DB): Logins {
  return {
    users: db.select().from(users).all(),
    sessions: db.select().from(sessions).all(),
    keys: db.select().from(apiKeys).all(),
    memberships: db.select().from(memberships).all(),
  };
}

/**
 * Sign-in state belongs to this server, not to the backup: restoring old data must not bring back a revoked API
 * key or an old password, or lock out whoever is restoring. User rows stay (history references their ids), but:
 *  - sessions and API keys are the current ones; the backup's are dropped;
 *  - who belongs to which portfolio is current too, for portfolios the backup has (keys for others are dropped);
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
        isInstanceAdmin: c.isInstanceAdmin,
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
    const portfolioIds = new Set(
      target
        .select({ id: portfolios.id })
        .from(portfolios)
        .all()
        .map((p) => p.id),
    );
    const currentIds = new Set(idMap.values());
    target
      .delete(memberships)
      .where(inArray(memberships.userId, [...currentIds]))
      .run();
    for (const m of current.memberships) {
      const userId = idMap.get(m.userId);
      if (userId && portfolioIds.has(m.portfolioId))
        target
          .insert(memberships)
          .values({ ...m, userId })
          .run();
    }
    for (const k of current.keys) {
      const userId = idMap.get(k.userId);
      if (userId && portfolioIds.has(k.portfolioId))
        target
          .insert(apiKeys)
          .values({ ...k, userId })
          .run();
    }
  });
  return { idMap, stats };
}

let restoring = false;

/**
 * Replace the whole database and receipts folder with a backup zip, in place, while the app keeps running.
 * The current data is first saved as a normal backup in `<data>/backups/`. Sign-in state (users' credentials,
 * sessions, API keys) is kept from the current database; see `mergeLogins`. Unpacking and checking happen on a staged
 * copy while the app keeps serving; then the maintenance gate closes (new requests get a 503, running ones finish)
 * for the safety copy and the swap, so no request sees a half-restored state or a closed database handle.
 */
export async function restoreBackup(db: DB, actor: Actor | null, data: Buffer, source = "upload") {
  if (actor) {
    requireInstanceAdmin(actor);
    // A read-only key can't restore. A browser session can, whatever its role in the portfolio the page is open in
    // (restoring is about the whole server, and the admin may be only looking into someone else's portfolio).
    if (actor.apiKeyId && !actor.canWrite) throw new AppError(403, "This API key is read-only");
  }
  if (restoring) throw new AppError(409, "A restore is already running");
  restoring = true;
  const dbPath = db.$client.name === ":memory:" ? resolve(config.databasePath) : resolve(db.$client.name);
  const uploadsDir = resolve(config.uploadsDir);
  const staged = `${dbPath}.restoring`;
  const stagedUploads = `${uploadsDir}.restoring`;
  const oldUploads = `${uploadsDir}.old`;
  const cleanup = () => {
    for (const p of [staged, `${staged}-wal`, `${staged}-shm`, stagedUploads])
      rmSync(p, { recursive: true, force: true });
  };
  try {
    const backup = readBackup(data);
    mkdirSync(dirname(dbPath), { recursive: true });
    for (const p of [staged, `${staged}-wal`, `${staged}-shm`, stagedUploads, oldUploads])
      rmSync(p, { recursive: true, force: true });

    // Unpack one entry at a time: memory holds the upload plus a single file.
    await writeFile(staged, await backup.db.read());
    const counts = checkDatabase(staged);
    for (const u of backup.uploads) {
      const p = join(stagedUploads, u.key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, await u.entry.read());
    }

    return await exclusive(async () => {
      // From here nothing else runs: logins read now are the final ones, and the safety copy is complete.
      const live = getDb();
      const target = openDb(staged);
      let merged: ReturnType<typeof mergeLogins>;
      try {
        merged = mergeLogins(target, readLogins(live));
      } finally {
        closeDb(target);
      }

      const backupsDir = join(config.dataDir, "backups");
      mkdirSync(backupsDir, { recursive: true });
      const savedAs = join(backupsDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
      await writeBackup(live, actor, savedAs, { gated: false });

      // Swap. Closing checkpoints the WAL; rename then atomically replaces the file. If that fails, reopen the original.
      live.$client.close();
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
      const restored = openDb(dbPath);
      setDb(restored);
      rmSync(oldUploads, { recursive: true, force: true });

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
    });
  } finally {
    cleanup();
    restoring = false;
  }
}
