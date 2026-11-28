import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

const dataDir = mkdtempSync(join(tmpdir(), "rental-restore-test-"));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_PATH;
delete process.env.UPLOADS_DIR;

const { getDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { createApp } = await import("./app.ts");
const { zip, unzip } = await import("./services/backup.ts");
const { readZip, streamToBuffer, zipStream } = await import("./services/zip.ts");
const { enter, exclusive, isClosed } = await import("./maintenance.ts");

seedDefaults(getDb());
const app = createApp();
let cookie = "";

async function call(
  method: string,
  path: string,
  body?: Uint8Array | FormData | object,
  headers: Record<string, string> = {},
) {
  const raw = body instanceof Uint8Array || body instanceof FormData;
  const res = await app.request(path, {
    method,
    headers: {
      ...(raw || body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? (body as Uint8Array | FormData) : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any;
  try {
    json = JSON.parse(buf.toString());
  } catch {
    json = undefined;
  }
  return { status: res.status, json, buf };
}

const addTx = async (amount: number) =>
  (await call("POST", "/api/transactions", { date: "2026-03-01", amount, category: "Supplies" })).json.id as number;
const count = async () => (await call("GET", "/api/transactions?limit=500")).json.items.length as number;

beforeAll(async () => {
  const r = await app.request("/api/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", name: "Owner", password: "correct horse battery" }),
  });
  cookie = r.headers.get("set-cookie")!.split(";")[0]!;
});

describe("zip reader", () => {
  const entries = [
    { name: "a.txt", data: Buffer.from("hello hello hello") },
    { name: "dir/b.bin", data: Buffer.from([0, 1, 2, 255]) },
    { name: "photo.jpg", data: Buffer.from("stored, not deflated") },
    { name: "empty.txt", data: Buffer.alloc(0) },
  ];
  const hex = (list: { name: string; data: Buffer }[]) => list.map((e) => [e.name, e.data.toString("hex")]);

  it("round-trips the zip writer", async () => {
    expect(hex(await unzip(zip(entries)))).toEqual(hex(entries));
  });

  it("round-trips a streamed zip, reading files from disk and skipping ones that are gone", async () => {
    const path = join(dataDir, "on-disk.txt");
    writeFileSync(path, "from disk");
    const z = zipStream([...entries, { name: "disk.txt", path }, { name: "gone.txt", path: join(dataDir, "nope") }]);
    const buf = await streamToBuffer(z.stream);
    expect(hex(await unzip(buf))).toEqual(hex([...entries, { name: "disk.txt", data: Buffer.from("from disk") }]));
    expect(await z.done).toEqual({ bytes: buf.length, files: 5, missing: ["gone.txt"] });
  });

  it("rejects garbage, and an entry that inflates past its declared size", async () => {
    expect(() => readZip(Buffer.from("not a zip at all, sorry"))).toThrow(/Not a zip/);
    // A zip bomb: 10 MB of zeros that claims to be 10 bytes.
    const bomb = zip([{ name: "rental.db", data: Buffer.alloc(10 * 1024 * 1024) }]);
    const cd = bomb.readUInt32LE(bomb.length - 6);
    bomb.writeUInt32LE(10, cd + 24); // central directory: uncompressed size
    await expect(unzip(bomb)).rejects.toThrow(/Corrupt zip entry/);
  });
});

describe("restore", () => {
  it("restores the database and receipts from a backup", async () => {
    const kept = await addTx(-12.5);
    const form = new FormData();
    form.append("file", new File(["receipt bytes"], "r.txt", { type: "text/plain" }));
    const att = (await call("POST", `/api/transactions/${kept}/attachments`, form)).json[0];
    expect(att.id).toBeGreaterThan(0);
    // A saved manager document is backed up too.
    const statement =
      'Channel,"Check-in date","Check-out date",XOwnerPayout,"Reservation ID"\nairbnb,2026-02-01,2026-02-03,$10.00,R1';
    const docForm = new FormData();
    docForm.append("file", new File([statement], "statement.csv", { type: "text/csv" }));
    const doc = (await call("POST", "/api/manager/documents", docForm)).json[0].document;
    expect(doc.month).toBe("2026-02");

    const backup = await call("GET", "/api/backup");
    expect(backup.status).toBe(200);

    // Changes after the backup: these should disappear.
    await addTx(-99);
    await call("DELETE", `/api/transactions/${kept}`);
    const before = await count();

    const r = await call("POST", "/api/backup/restore", new Uint8Array(backup.buf), {
      "content-type": "application/zip",
      "x-filename": "test%20backup.zip",
    });
    expect(r.status).toBe(200);
    expect(r.json.transactions).toBe(1);
    expect(r.json.receipts).toBe(2);
    expect(existsSync(r.json.previous_data_saved_as)).toBe(true);

    // The restoring admin stays signed in.
    expect(await count()).toBe(1);
    expect(before).toBe(1);
    expect((await call("GET", `/api/transactions/${kept}`)).json.amount).toBe(-12.5);
    const file = await call("GET", `/api/attachments/${att.id}`);
    expect(file.buf.toString()).toBe("receipt bytes");
    expect((await call("GET", `/api/manager/documents/${doc.id}/file`)).buf.toString()).toBe(statement);

    const auditRows = (await call("GET", "/api/admin/audit?entity=backup")).json;
    const restored = (auditRows.items ?? auditRows).find((a: any) => a.action === "restore");
    expect(restored.changes.source).toBe("test backup.zip");

    // The safety copy holds the pre-restore state (2 live transactions incl. the -99 one) and restores too.
    const undo = await call(
      "POST",
      "/api/backup/restore",
      new Uint8Array(readFileSync(r.json.previous_data_saved_as)),
      {
        "content-type": "application/zip",
      },
    );
    expect(undo.status).toBe(200);
    expect(await count()).toBe(1);
    expect((await call("GET", "/api/transactions?limit=500")).json.items[0].amount).toBe(-99);
  });

  it("keeps this server's sign-ins instead of the backup's", async () => {
    const login = async (email: string, password: string) => {
      const r = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      return r.status === 200 ? r.headers.get("set-cookie")!.split(";")[0]! : null;
    };
    const me = async (headers: Record<string, string>) => {
      const r = await app.request("/api/auth/me", { headers });
      return ((await r.json()) as { user: { id: number; email: string } | null }).user;
    };
    const ownerPw = "correct horse battery";

    // State captured in the backup: an API key that is later revoked, and a user later disabled.
    const oldKey = (await call("POST", "/api/api-keys", { name: "old", scope: "write" })).json;
    const alice = (await call("POST", "/api/users", { email: "alice@example.com", password: "alice password" })).json;
    const backupZip = (await call("GET", "/api/backup")).buf;

    // After the backup: revoke the key, add a key, change the owner's password, disable alice, add bob.
    expect((await call("DELETE", `/api/api-keys/${oldKey.id}`)).status).toBeLessThan(300);
    const newKey = (await call("POST", "/api/api-keys", { name: "new", scope: "write" })).json.key as string;
    expect((await call("POST", "/api/auth/password", { current: ownerPw, next: "a brand new password" })).status).toBe(
      200,
    );
    await call("PATCH", `/api/users/${alice.id}`, { disabled: true });
    const bob = (await call("POST", "/api/users", { email: "bob@example.com", password: "bob password!" })).json;
    const bobCookie = (await login("bob@example.com", "bob password!"))!;

    // Doctor the backup: carol exists only there, and holds bob's id so bob has to move.
    const restoredEntries = await unzip(backupZip);
    const dbFile = join(dataDir, "doctored.db");
    writeFileSync(dbFile, restoredEntries.find((e) => e.name === "rental.db")!.data);
    const doctored = new Database(dbFile);
    doctored
      .prepare(
        "INSERT INTO users (id, email, name, password_hash, role) VALUES (?, 'carol@example.com', 'Carol', ?, 'admin')",
      )
      .run(bob.id, "x");
    doctored.prepare("INSERT INTO memberships (user_id, portfolio_id, role) VALUES (?, 1, 'admin')").run(bob.id);
    doctored.close();
    const zipped = zip(restoredEntries.map((e) => (e.name === "rental.db" ? { ...e, data: readFileSync(dbFile) } : e)));

    const r = await call("POST", "/api/backup/restore", new Uint8Array(zipped), { "content-type": "application/zip" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ users_kept: 2, users_disabled: 1, users_added: 1 });

    // Current password, not the backup's.
    expect(await login("owner@example.com", ownerPw)).toBeNull();
    expect(await login("owner@example.com", "a brand new password")).not.toBeNull();
    // Revoked key stays revoked; the newer key works.
    expect((await me({ authorization: `Bearer ${oldKey.key}` }))?.email).toBeUndefined();
    expect((await me({ authorization: `Bearer ${newKey}` }))?.email).toBe("owner@example.com");
    // alice stays disabled (current status), carol is disabled, bob kept his session under a new id.
    const list = (await call("GET", "/api/users")).json as { id: number; email: string; disabled: boolean }[];
    const byEmail = Object.fromEntries(list.map((u) => [u.email, u]));
    expect(byEmail["alice@example.com"]!.disabled).toBeTruthy();
    expect(byEmail["carol@example.com"]!.disabled).toBeTruthy();
    expect(byEmail["carol@example.com"]!.id).toBe(bob.id);
    expect(byEmail["bob@example.com"]!.disabled).toBeFalsy();
    const bobNow = await me({ cookie: bobCookie });
    expect(bobNow?.email).toBe("bob@example.com");
    expect(bobNow?.id).not.toBe(bob.id);
    expect(await login("carol@example.com", "anything at all")).toBeNull();
  });

  it("rejects zips that are not backups and leaves data alone", async () => {
    const n = await count();
    const notBackup = zip([{ name: "hello.txt", data: Buffer.from("hi") }]);
    const r1 = await call("POST", "/api/backup/restore", new Uint8Array(notBackup));
    expect(r1.status).toBe(400);
    expect(r1.json.error).toMatch(/no rental.db/);

    const fakeDb = zip([{ name: "rental.db", data: Buffer.from("SQLite format 3\0 but not really") }]);
    expect((await call("POST", "/api/backup/restore", new Uint8Array(fakeDb))).status).toBe(400);

    const sneaky = zip([
      { name: "rental.db", data: Buffer.from("x") },
      { name: "uploads/../../etc/passwd", data: Buffer.from("x") },
    ]);
    expect((await call("POST", "/api/backup/restore", new Uint8Array(sneaky))).json.error).toMatch(/Unsafe path/);
    expect(await count()).toBe(n);
  });

  it("rejects a backup from a newer app version", async () => {
    const path = join(dataDir, "newer.db");
    getDb().$client.exec(`VACUUM INTO '${path}'`);
    const other = new Database(path);
    other.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 0)").run();
    other.close();
    const r = await call(
      "POST",
      "/api/backup/restore",
      new Uint8Array(zip([{ name: "rental.db", data: readFileSync(path) }])),
    );
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/newer version/);
  });

  it("waits for running work, turns new requests away while it swaps, and allows one restore at a time", async () => {
    const backup = await call("GET", "/api/backup");
    expect(backup.status).toBe(200);
    const running = enter(); // stands in for a request or download still in progress
    const restoring = call("POST", "/api/backup/restore", new Uint8Array(backup.buf));
    await vi.waitFor(() => expect(isClosed()).toBe(true));

    const busy = await app.request("/api/transactions", { headers: { cookie } });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("30");
    expect((await call("POST", "/api/backup/restore", new Uint8Array(backup.buf))).status).toBe(409);

    running();
    expect((await restoring).status).toBe(200);
    expect(isClosed()).toBe(false);
    expect((await call("GET", "/api/transactions")).status).toBe(200);
  });

  it("lets go of the gate when a download is cancelled part way", async () => {
    const { createBackup } = await import("./services/backup.ts");
    const actor = {
      user: { id: 1, email: "owner@example.com", name: "Owner", role: "admin" as const, instance_admin: true },
      apiKeyId: null,
      canWrite: true,
      via: "web" as const,
    };
    const b = createBackup(getDb(), actor);
    const reader = b.stream.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    await expect(b.done).rejects.toThrow();
    await exclusive(() => {}, 200); // nothing is holding the gate any more
  });

  it("gives up and reopens when running work doesn't finish in time", async () => {
    const running = enter();
    let ran = false;
    await expect(
      exclusive(() => {
        ran = true;
      }, 20),
    ).rejects.toMatchObject({ status: 503 });
    expect(ran).toBe(false);
    expect(isClosed()).toBe(false);
    running();
    enter()(); // open again
  });

  it("is admin-only", async () => {
    const key = (await call("POST", "/api/api-keys", { name: "reader", scope: "read" })).json.key;
    const saved = cookie;
    cookie = "";
    const r = await call("POST", "/api/backup/restore", new Uint8Array([1]), { authorization: `Bearer ${key}` });
    cookie = saved;
    expect(r.status).toBe(403);
  });

  it("lets the server's administrator restore while only looking into someone's portfolio", async () => {
    const { restoreBackup } = await import("./services/backup.ts");
    const viewing = {
      user: { id: 1, email: "owner@example.com", name: "Owner", role: "viewer" as const, instance_admin: true },
      apiKeyId: null,
      canWrite: false,
      via: "web" as const,
    };
    // past the permission checks: refused only because these bytes aren't a backup
    await expect(restoreBackup(getDb(), viewing, Buffer.from([1]))).rejects.not.toMatchObject({ status: 403 });
  });
});
