import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb, setDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { createApp } = await import("./app.ts");
const { depreciationForYear } = await import("./services/reports.ts");

const db = openDb(":memory:");
setDb(db);
seedDefaults(db);
const app = createApp();

let cookie = "";
let writeKey = "";
let readKey = "";

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie && !headers.authorization ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, res };
}
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

beforeAll(async () => {
  const r = await call("POST", "/api/auth/setup", {
    email: "Owner@Example.com",
    name: "Owner",
    password: "correct horse battery",
  });
  expect(r.status).toBe(200);
  cookie = r.res.headers.get("set-cookie")!.split(";")[0]!;
});

describe("auth", () => {
  it("rejects anonymous access and a second setup", async () => {
    const saved = cookie;
    cookie = "";
    expect((await call("GET", "/api/transactions")).status).toBe(401);
    expect((await call("POST", "/api/auth/setup", { email: "x@y.z", password: "0123456789" })).status).toBe(403);
    expect((await call("POST", "/api/auth/login", { email: "owner@example.com", password: "nope" })).status).toBe(401);
    const ok = await call("POST", "/api/auth/login", { email: "owner@example.com", password: "correct horse battery" });
    expect(ok.status).toBe(200);
    cookie = saved;
  });

  it("blocks cross-site cookie writes", async () => {
    const r = await call(
      "POST",
      "/api/transactions",
      { date: "2026-01-01", amount: -1, category: "Supplies" },
      { origin: "https://evil.example" },
    );
    expect(r.status).toBe(403);
  });

  it("issues API keys with scopes", async () => {
    const w = await call("POST", "/api/api-keys", { name: "agent", scope: "write" });
    expect(w.status).toBe(201);
    writeKey = w.json.key;
    expect(writeKey).toMatch(/^rk_/);
    readKey = (await call("POST", "/api/api-keys", { name: "reader", scope: "read" })).json.key;
    expect((await call("GET", "/api/transactions", undefined, bearer(readKey))).status).toBe(200);
    const denied = await call(
      "POST",
      "/api/transactions",
      { date: "2026-01-01", amount: -1, category: "Supplies" },
      bearer(readKey),
    );
    expect(denied.status).toBe(403);
    expect((await call("GET", "/api/transactions", undefined, bearer("rk_bogus"))).status).toBe(401);
    // API keys cannot mint more keys
    expect((await call("POST", "/api/api-keys", { name: "x" }, bearer(writeKey))).status).toBe(403);
  });
});

describe("transactions", () => {
  it("creates an expense with default allocation and enforces sign", async () => {
    const bad = await call(
      "POST",
      "/api/transactions",
      { date: "2026-03-02", amount: 50, category: "Supplies" },
      bearer(writeKey),
    );
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/negative/);
    const r = await call(
      "POST",
      "/api/transactions",
      { date: "2026-03-02", amount: -50.25, category: "supplies", vendor: "Costco" },
      bearer(writeKey),
    );
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ amount: -50.25, category: "Supplies", allocation: "direct", source: "api" });
    const refund = await call(
      "POST",
      "/api/transactions",
      { date: "2026-03-05", amount: 10, category: "Supplies", refund: true },
      bearer(writeKey),
    );
    expect(refund.status).toBe(201);
  });

  it("gives a helpful error for unknown categories", async () => {
    const r = await call(
      "POST",
      "/api/transactions",
      { date: "2026-03-02", amount: -5, category: "Snacks" },
      bearer(writeKey),
    );
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("Valid categories");
  });

  it("bulk import detects duplicates, supports dry run", async () => {
    const rows = [
      { date: "2026-03-02", amount: -50.25, category: "Supplies" }, // dup of above
      { date: "2026-03-10", amount: 1200, category: "Rental Income", vendor: "Airbnb", reference: "PAYOUT 1" },
      { date: "2026-03-10", amount: 1200, category: "Rental Income", vendor: "Airbnb", reference: "PAYOUT 1" }, // dup in batch
      { date: "nope", amount: 1, category: "Rental Income" },
    ];
    const dry = await call("POST", "/api/transactions/bulk", { transactions: rows, dry_run: true }, bearer(writeKey));
    expect(dry.json).toMatchObject({ would_create: 1, duplicates: 2, errors: 1, created: 0 });
    const real = await call("POST", "/api/transactions/bulk", { transactions: rows }, bearer(writeKey));
    expect(real.json).toMatchObject({ created: 1, duplicates: 2, errors: 1 });
    const again = await call("POST", "/api/transactions/bulk", { transactions: rows.slice(1, 2) }, bearer(writeKey));
    expect(again.json.duplicates).toBe(1);
  });

  it("updates, audits and soft-deletes", async () => {
    const list = await call("GET", "/api/transactions?q=Costco");
    const id = list.json.items[0].id;
    const up = await call("PATCH", `/api/transactions/${id}`, {
      allocation: "indirect",
      needs_review: true,
      review_note: "unsure",
    });
    expect(up.json).toMatchObject({ allocation: "indirect", needs_review: true });
    const audit = await call("GET", `/api/audit?entity=transaction&entity_id=${id}`);
    expect(audit.json[0].changes.allocation).toEqual(["direct", "indirect"]);
    expect(audit.json.at(-1).via).toBe("api");
    expect((await call("DELETE", `/api/transactions/${id}`)).status).toBe(200);
    expect((await call("GET", `/api/transactions/${id}`)).status).toBe(404);
    expect((await call("POST", `/api/transactions/${id}/restore`)).status).toBe(200);
  });
});

describe("tax report", () => {
  it("allocates indirect expenses by rental-use percentage", async () => {
    await call("PUT", "/api/occupancy", [
      { month: "2026-01", nights_booked: 20, owner_nights: 5, check_ins: 6 },
      { month: "2026-02", nights_booked: 25, owner_nights: 0, check_ins: 8 },
    ]);
    await call("POST", "/api/transactions", { date: "2026-01-01", amount: -1000, category: "Mortgage" });
    await call("POST", "/api/transactions", { date: "2026-02-01", amount: -300, category: "Insurance" });
    await call("PUT", "/api/tax-years/2026", { mortgage_interest: 600 });
    const r = await call("GET", "/api/reports/tax?year=2026");
    expect(r.status).toBe(200);
    const t = r.json;
    expect(t.use).toMatchObject({ rental_days: 45, personal_days: 5, rental_pct: 0.9 });
    // indirect: mortgage 1000 + insurance 300 (+ restored Costco item 50.25 marked indirect)
    expect(t.expenses.indirect.total).toBeCloseTo(1350.25);
    const line12 = t.schedule_e.find((l: any) => l.line === "12");
    expect(line12.indirect).toBe(600); // uses 1098 interest, not payments
    expect(line12.total).toBe(540);
    const line9 = t.schedule_e.find((l: any) => l.line === "9");
    expect(line9.total).toBe(270);
    expect(t.checks.map((c: any) => c.code)).toContain("needs_review");
    const csv = await call("GET", "/api/reports/tax.csv?year=2026");
    expect(csv.res.headers.get("content-type")).toContain("text/csv");
  });

  it("computes mid-month MACRS depreciation", () => {
    // $275,000 placed in service in July: (12 - 7 + 0.5)/12 * 10,000 = 4,583.33
    expect(depreciationForYear(275000, "2025-07-15", 27.5, 2025).amount).toBe(4583.33);
    expect(depreciationForYear(275000, "2025-07-15", 27.5, 2026).amount).toBe(10000);
    expect(depreciationForYear(275000, "2025-07-15", 27.5, 2024).amount).toBe(0);
  });
});

describe("backup", () => {
  it("downloads a zip with the database", async () => {
    const r = await call("GET", "/api/backup");
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type")).toBe("application/zip");
    expect(r.res.headers.get("content-disposition")).toMatch(/rental-ledger-backup-\d{4}-\d{2}-\d{2}\.zip/);
    expect((await call("GET", "/api/backup", undefined, bearer(readKey))).status).toBe(200); // owner's key is admin
  });

  it("writes a valid zip", async () => {
    const { zip } = await import("./services/backup.ts");
    const { inflateRawSync } = await import("node:zlib");
    const z = zip([{ name: "a.txt", data: Buffer.from("hello hello hello") }]);
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = z.readUInt16LE(26);
    const size = z.readUInt32LE(18);
    expect(inflateRawSync(z.subarray(30 + nameLen, 30 + nameLen + size)).toString()).toBe("hello hello hello");
    expect(z.readUInt32LE(z.length - 22)).toBe(0x06054b50);
  });
});

describe("mcp", () => {
  const rpc = (method: string, params: unknown, key = writeKey) =>
    app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...bearer(key) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  it("requires an API key", async () => {
    const res = await app.request("/mcp", { method: "POST", headers: { cookie }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("lists tools and adds an expense", async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(init.status).toBe(200);
    const tools: any = await (await rpc("tools/list", {})).json();
    const names = tools.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["add_expense", "get_tax_report", "bulk_add_transactions"]));
    const res: any = await (
      await rpc("tools/call", {
        name: "add_expense",
        arguments: { date: "2026-04-01", amount: 75, category: "Cleaning", vendor: "Acme PM" },
      })
    ).json();
    expect(res.result.isError).toBeFalsy();
    const tx = JSON.parse(res.result.content[0].text);
    expect(tx).toMatchObject({ amount: -75, source: "mcp", allocation: "direct" });
    const denied: any = await (
      await rpc(
        "tools/call",
        { name: "add_expense", arguments: { date: "2026-04-01", amount: 5, category: "Cleaning" } },
        readKey,
      )
    ).json();
    expect(denied.result.isError).toBe(true);
  });
});
