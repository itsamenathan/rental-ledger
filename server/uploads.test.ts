import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { pendingUploads, users } = await import("./db/schema.ts");
const ledger = await import("./services/ledger.ts");
const files = await import("./services/attachments.ts");
const uploads = await import("./services/uploads.ts");
const { pathFor } = await import("./services/storage.ts");

function setup() {
  const db = openDb(":memory:");
  seedDefaults(db);
  const mk = (email: string) => {
    const user = db.insert(users).values({ email, role: "admin" }).returning().get();
    return { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  };
  const actor = mk("t@example.com");
  const stage = (text: string, a = actor) =>
    uploads.stageUpload(db, a, {
      filename: "receipt.pdf",
      contentType: "application/pdf",
      data: new TextEncoder().encode(text),
    });
  const keyOf = (id: number) =>
    db.select({ key: pendingUploads.storageKey }).from(pendingUploads).where(eq(pendingUploads.id, id)).get()!.key;
  const entry = { date: "2026-10-02", amount: -40, category: "Maintenance" };
  return { db, actor, mk, stage, keyOf, entry };
}

describe("receipt uploads before saving", () => {
  it("attaches staged receipts when the new entry is saved", async () => {
    const { db, actor, stage, entry } = setup();
    const a = await stage("receipt one");
    const b = await stage("receipt two");
    const t = ledger.createTransaction(db, actor, { ...entry, upload_ids: [a.id, b.id] });
    expect(t.attachment_count).toBe(2);
    expect(files.listAttachments(db, t.id).map((x) => x.filename)).toEqual(["receipt.pdf", "receipt.pdf"]);
    expect(db.select().from(pendingUploads).all()).toHaveLength(0);
  });

  it("keeps nothing if the entry isn't saved, and a replay of the save attaches once", async () => {
    const { db, actor, stage, entry } = setup();
    const a = await stage("receipt");
    expect(() =>
      ledger.createTransaction(db, actor, { ...entry, category: "No such category", upload_ids: [a.id] }),
    ).toThrow();
    expect(db.select().from(pendingUploads).all()).toHaveLength(1);

    const t = ledger.createTransaction(db, actor, { ...entry, client_id: "client-123456", upload_ids: [a.id] });
    const again = ledger.createTransaction(db, actor, { ...entry, client_id: "client-123456", upload_ids: [a.id] });
    expect(again.id).toBe(t.id);
    expect(files.listAttachments(db, t.id)).toHaveLength(1);
  });

  it("refuses an expired upload or someone else's, saving nothing", async () => {
    const { db, actor, mk, stage, entry } = setup();
    const other = await stage("theirs", mk("o@example.com"));
    const before = ledger.listTransactions(db, {}).total;
    expect(() => ledger.createTransaction(db, actor, { ...entry, upload_ids: [other.id] })).toThrow(/expired/);
    expect(() => ledger.createTransaction(db, actor, { ...entry, upload_ids: [9999] })).toThrow(/expired/);
    expect(ledger.listTransactions(db, {}).total).toBe(before);
  });

  it("attaches on an edit, skipping a file the entry already has", async () => {
    const { db, actor, stage, entry } = setup();
    const t = ledger.createTransaction(db, actor, entry);
    await files.addAttachment(db, actor, t.id, {
      filename: "old.pdf",
      contentType: "application/pdf",
      data: new TextEncoder().encode("same bytes"),
    });
    const dup = await stage("same bytes");
    const fresh = await stage("new bytes");
    const after = ledger.updateTransaction(db, actor, t.id, {
      upload_ids: [dup.id, fresh.id],
      expected_updated_at: t.updated_at,
    });
    expect(after.attachment_count).toBe(2);
    expect(db.select().from(pendingUploads).all()).toHaveLength(0);
  });

  it("discards only the caller's uploads and removes the file once nothing else uses it", async () => {
    const { db, actor, mk, stage, keyOf } = setup();
    const a = await stage("discard me");
    const theirs = await stage("not yours", mk("o@example.com"));
    const key = keyOf(a.id);
    expect(existsSync(pathFor(key))).toBe(true);
    expect(await uploads.discardUploads(db, actor, [a.id, theirs.id])).toEqual({ discarded: 1 });
    expect(existsSync(pathFor(key))).toBe(false);
    expect(existsSync(pathFor(keyOf(theirs.id)))).toBe(true);
  });

  it("keeps a file shared with an attachment when either side goes away", async () => {
    const { db, actor, stage, keyOf, entry } = setup();
    const t = ledger.createTransaction(db, actor, entry);
    const [att] = [
      await files.addAttachment(db, actor, t.id, {
        filename: "r.pdf",
        contentType: "application/pdf",
        data: new TextEncoder().encode("shared"),
      }),
    ];
    const staged = await stage("shared");
    const key = keyOf(staged.id);
    await files.deleteAttachment(db, actor, att!.id);
    expect(existsSync(pathFor(key))).toBe(true); // the pending upload still needs it
    const t2 = ledger.createTransaction(db, actor, { ...entry, upload_ids: [staged.id] });
    expect(files.listAttachments(db, t2.id)).toHaveLength(1);
    expect(existsSync(pathFor(key))).toBe(true);
  });

  it("prunes uploads from abandoned forms", async () => {
    const { db, stage, keyOf } = setup();
    const a = await stage("abandoned");
    const key = keyOf(a.id);
    db.update(pendingUploads).set({ createdAt: "2020-01-01T00:00:00.000Z" }).run();
    expect(await uploads.pruneStaleUploads(db)).toBe(1);
    expect(existsSync(pathFor(key))).toBe(false);
  });

  it("never prunes a saved receipt, even when an abandoned upload shares its file", async () => {
    const { db, actor, stage, keyOf, entry } = setup();
    const saved = await stage("same photo");
    const t = ledger.createTransaction(db, actor, { ...entry, upload_ids: [saved.id] });
    const abandoned = await stage("same photo"); // picked again on a form that was never saved
    const key = keyOf(abandoned.id);
    db.update(pendingUploads).set({ createdAt: "2020-01-01T00:00:00.000Z" }).run();

    expect(await uploads.pruneStaleUploads(db)).toBe(1);
    expect(db.select().from(pendingUploads).all()).toHaveLength(0);
    const [att] = files.listAttachments(db, t.id);
    expect(att).toBeDefined();
    expect(existsSync(pathFor(key))).toBe(true);
    expect(new TextDecoder().decode((await files.readAttachment(db, att!.id)).data)).toBe("same photo");
  });
});
