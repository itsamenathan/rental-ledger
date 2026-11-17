import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb } = await import("./db.ts");
const { config } = await import("./config.ts");
const { seedDefaults } = await import("./seed.ts");
const { managerDocuments, properties, users } = await import("./db/schema.ts");
const ledger = await import("./services/ledger.ts");
const files = await import("./services/attachments.ts");
const library = await import("./services/files.ts");
const { streamToBuffer, unzip } = await import("./services/zip.ts");
const { sha256, storeBytes } = await import("./services/storage.ts");

function setup() {
  const db = openDb(":memory:");
  seedDefaults(db);
  const user = db.insert(users).values({ email: "t@example.com", role: "admin" }).returning().get();
  const actor = { user: { ...user, role: "admin" as const }, apiKeyId: null, canWrite: true, via: "web" as const };
  const expense = (date: string, amount: number, vendor = "Hardware Store") =>
    ledger.createTransaction(db, actor, { date, amount, category: "Maintenance", vendor }).id;
  const attach = (txId: number, text: string, filename = "receipt.pdf") =>
    files.addAttachment(db, actor, txId, {
      filename,
      contentType: "application/pdf",
      data: new TextEncoder().encode(text),
    });
  return { db, actor, expense, attach };
}

describe("file library", () => {
  it("files a receipt under its entry's month, not the upload month, and skips trashed entries", async () => {
    const { db, actor, expense, attach } = setup();
    const sep = expense("2026-09-28", -120);
    const oct = expense("2026-10-02", -40);
    const trashed = expense("2026-10-05", -90);
    await attach(sep, "september receipt");
    await attach(oct, "october receipt");
    await attach(trashed, "gone");
    ledger.deleteTransaction(db, actor, trashed);

    const lib = library.listFiles(db, { month: "2026-10" });
    expect(lib.files.map((f) => f.links.map((l) => l.transaction_id))).toEqual([[oct]]);
    expect(library.listFiles(db, { month: "2026-09" }).files).toHaveLength(1);
    expect(library.listFiles(db, { year: 2026 }).files).toHaveLength(2);
  });

  it("lists a manager statement attached to several entries once, labelled as manager paperwork", async () => {
    const { db, actor, expense, attach } = setup();
    const a = expense("2026-10-03", -60, "Acme PM");
    const b = expense("2026-10-20", -30, "Acme PM");
    const bytes = new TextEncoder().encode("owner statement csv");
    const property = db.select().from(properties).get()!;
    await storeBytes(db, bytes, "csv", (key) =>
      db
        .insert(managerDocuments)
        .values({
          propertyId: property.id,
          month: "2026-10",
          kind: "statement",
          filename: "statement.csv",
          contentType: "text/csv",
          size: bytes.byteLength,
          sha256: sha256(bytes),
          storageKey: key,
          text: "",
          createdBy: actor.user.id,
        })
        .run(),
    );
    await attach(a, "owner statement csv", "statement.csv");
    await attach(b, "owner statement csv", "statement.csv");
    await attach(b, "fee invoice");

    const lib = library.listFiles(db, { month: "2026-10" });
    expect(lib.files).toHaveLength(2);
    const [statement, invoice] = lib.files;
    expect(statement!.manager?.kind).toBe("statement");
    expect(statement!.links.map((l) => l.transaction_id)).toEqual([a, b]);
    expect(invoice!.manager).toBeNull();
    expect(library.listFiles(db, { month: "2026-10", source: "receipts" }).files).toHaveLength(1);
    expect(library.listFiles(db, { month: "2026-10", source: "manager" }).files).toHaveLength(1);

    const z = library.filesZip(db, actor, { month: "2026-10" });
    expect((await unzip(await streamToBuffer(z.stream))).map((e) => e.name)).toEqual([
      "2026-10 - Manager statement.csv",
      "2026-10-20 - Acme PM - 30.00.pdf",
    ]);
  });

  it("files manager paperwork under the month it covers, even when attached to an entry in another month", async () => {
    const { db, actor, expense, attach } = setup();
    const deposit = expense("2026-09-28", -60, "Acme PM");
    const bytes = new TextEncoder().encode("october statement");
    const property = db.select().from(properties).get()!;
    await storeBytes(db, bytes, "csv", (key) =>
      db
        .insert(managerDocuments)
        .values({
          propertyId: property.id,
          month: "2026-10",
          kind: "statement",
          filename: "october.csv",
          contentType: "text/csv",
          size: bytes.byteLength,
          sha256: sha256(bytes),
          storageKey: key,
          text: "",
          createdBy: actor.user.id,
        })
        .run(),
    );
    await attach(deposit, "october statement", "october.csv");

    const year = library.listFiles(db, { year: 2026 });
    expect(year.files.map((f) => [f.month, f.links.length])).toEqual([["2026-10", 1]]);
    const oct = library.listFiles(db, { month: "2026-10" });
    expect(oct.files.map((f) => [f.manager?.kind, f.links.length])).toEqual([["statement", 0]]);
  });

  it("lists expenses over the threshold without a receipt and filters by text", async () => {
    const { db, expense, attach } = setup();
    const big = expense("2026-10-04", -250, "Roofer");
    expense("2026-10-05", -20, "Coffee");
    const done = expense("2026-10-06", -300, "Plumber");
    await attach(done, "plumber invoice", "plumber.pdf");

    const lib = library.listFiles(db, { month: "2026-10" });
    expect(lib.missing.map((t) => t.id)).toEqual([big]);
    expect(library.listFiles(db, { month: "2026-10", q: "plumb" }).files).toHaveLength(1);
    expect(library.listFiles(db, { month: "2026-10", q: "roof" }).files).toHaveLength(0);
  });
});

describe("updateAttachment", () => {
  it("renames and moves a file, and drops the copy when the target already has it", async () => {
    const { db, actor, expense, attach } = setup();
    const a = expense("2026-10-01", -100);
    const b = expense("2026-10-02", -100);
    const first = await attach(a, "same bytes", "first.pdf");

    const renamed = await files.updateAttachment(db, actor, first.id, { filename: "roof/repair.pdf" });
    expect(renamed.filename).toBe("roof_repair.pdf");

    const moved = await files.updateAttachment(db, actor, first.id, { transaction_id: b });
    expect(moved.transaction_id).toBe(b);
    expect(files.listAttachments(db, a)).toEqual([]);

    const again = await attach(a, "same bytes", "again.pdf");
    const merged = await files.updateAttachment(db, actor, again.id, { transaction_id: b });
    expect(merged.id).toBe(first.id);
    expect(files.listAttachments(db, b)).toHaveLength(1);
    expect(files.listAttachments(db, a)).toHaveLength(0);
    // The shared stored file is still readable.
    expect((await files.readAttachment(db, first.id)).data.toString()).toBe("same bytes");
  });

  it("refuses to move a file onto a trashed entry", async () => {
    const { db, actor, expense, attach } = setup();
    const a = expense("2026-10-01", -100);
    const b = expense("2026-10-02", -100);
    const f = await attach(a, "x");
    ledger.deleteTransaction(db, actor, b);
    await expect(files.updateAttachment(db, actor, f.id, { transaction_id: b })).rejects.toThrow();
  });
});

describe("linkAttachment", () => {
  it("shares one file across entries, and only deletes it when the last link goes", async () => {
    const { db, actor, expense, attach } = setup();
    const a = expense("2026-10-01", -100);
    const b = expense("2026-10-02", -50);
    const sep = expense("2026-09-30", -10);
    const f = await attach(a, "split invoice", "invoice.pdf");

    const linked = files.linkAttachment(db, actor, f.id, { transaction_id: b });
    expect(linked.transaction_id).toBe(b);
    expect(linked.filename).toBe("invoice.pdf");
    // Linking again is a no-op.
    expect(files.linkAttachment(db, actor, f.id, { transaction_id: b }).id).toBe(linked.id);

    let [file] = library.listFiles(db, { month: "2026-10" }).files;
    expect(file!.links.map((l) => l.transaction_id)).toEqual([a, b]);
    expect(file!.other_uses).toBe(0);

    // A link outside the period keeps the file even when every listed entry is unlinked.
    files.linkAttachment(db, actor, f.id, { transaction_id: sep });
    [file] = library.listFiles(db, { month: "2026-10" }).files;
    expect(file!.other_uses).toBe(1);

    await files.deleteAttachment(db, actor, f.id);
    await files.deleteAttachment(db, actor, linked.id);
    const [left] = library.listFiles(db, { month: "2026-09" }).files;
    expect(left!.links.map((l) => l.transaction_id)).toEqual([sep]);
    expect((await files.readAttachment(db, left!.links[0]!.attachment_id)).data.toString()).toBe("split invoice");
  });
});

describe("shared stored files", () => {
  it("keeps a file that a new upload reuses while its last other reference is deleted", async () => {
    const { db, actor, expense, attach } = setup();
    const a = expense("2026-10-01", -10);
    const b = expense("2026-10-02", -10);
    const first = await attach(a, "same bytes");
    // Upload the same bytes to b while a's attachment (the only other reference) is deleted.
    const [second] = await Promise.all([attach(b, "same bytes"), files.deleteAttachment(db, actor, first.id)]);
    const read = await files.readAttachment(db, second.id);
    expect(Buffer.from(read.data).toString()).toBe("same bytes");
  });

  it("removes a newly written file when the row that would use it can't be saved", async () => {
    const { db } = setup();
    const txtFiles = () =>
      existsSync(config.uploadsDir)
        ? readdirSync(config.uploadsDir, { recursive: true }).filter((f) => String(f).endsWith(".txt")).length
        : 0;
    const before = txtFiles();
    await expect(
      storeBytes(db, new TextEncoder().encode("never saved"), "txt", () => {
        throw new Error("insert failed");
      }),
    ).rejects.toThrow("insert failed");
    await vi.waitFor(() => expect(txtFiles()).toBe(before)); // the unlink finishes in the background
  });
});
