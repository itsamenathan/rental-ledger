/** Several properties: each is its own set of books, and nothing is summed across them unless asked ("all"). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));

const { openDb, setDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { createApp } = await import("./app.ts");
const ledger = await import("./services/ledger.ts");

const db = openDb(":memory:");
setDb(db);
seedDefaults(db);
const app = createApp();
let key = "";

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const mcp = async (name: string, args: Record<string, unknown>) => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const r = ((await res.json()) as any).result;
  return { isError: !!r.isError, text: r.content[0].text as string };
};

let first = 0;
let second = 0;

beforeAll(async () => {
  const setup = await app.request("/api/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "o@example.com", password: "correct horse battery" }),
  });
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const k = await app.request("/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "agent", scope: "write" }),
  });
  key = ((await k.json()) as any).key;
  first = ledger.listProperties(db)[0]!.id;
});

describe("one property", () => {
  it("may be left out everywhere", async () => {
    expect(
      (await call("POST", "/api/transactions", { date: "2026-02-01", amount: -40, category: "Supplies" })).status,
    ).toBe(201);
    expect((await call("GET", "/api/transactions")).json.total).toBe(1);
    expect((await call("GET", "/api/reports/summary?year=2026")).json.totals.expense).toBe(40);
    expect((await call("GET", "/api/reports/tax?year=2026")).status).toBe(200);
  });
});

describe("several properties", () => {
  beforeAll(async () => {
    const r = await call("POST", "/api/properties", { name: "Cabin" });
    expect(r.status).toBe(201);
    second = r.json.id;
    await call("POST", "/api/transactions", {
      date: "2026-02-03",
      amount: -60,
      category: "Supplies",
      property_id: second,
    });
  });

  it("refuses to guess which property", async () => {
    for (const path of [
      "/api/transactions",
      "/api/reports/summary?year=2026",
      "/api/todo",
      "/api/recurring",
      "/api/files",
      "/api/occupancy",
      "/api/reports/tax?year=2026",
      "/api/calendar",
      "/api/manager/months?year=2026",
    ]) {
      const r = await call("GET", path);
      expect(r.status, path).toBe(400);
      expect(r.json.error, path).toMatch(/property/);
    }
    const w = await call("POST", "/api/transactions", { date: "2026-02-04", amount: -1, category: "Supplies" });
    expect(w.status).toBe(400);
  });

  it("keeps each property's books apart", async () => {
    expect((await call("GET", `/api/transactions?property_id=${first}`)).json.total).toBe(1);
    expect((await call("GET", "/api/transactions?property=cabin")).json.total).toBe(1);
    expect((await call("GET", `/api/reports/summary?year=2026&property_id=${second}`)).json.totals.expense).toBe(60);
  });

  it('adds them up only when asked with "all"', async () => {
    expect((await call("GET", "/api/transactions?property=all")).json.total).toBe(2);
    const s = (await call("GET", "/api/reports/summary?year=2026&property_id=all")).json;
    expect(s.totals.expense).toBe(100);
    expect(s.by_property.map((p: any) => [p.property, p.expense])).toEqual(
      expect.arrayContaining([
        ["Cabin", 60],
        [expect.any(String), 40],
      ]),
    );
    expect((await call("GET", `/api/reports/summary?year=2026&property_id=${first}`)).json.by_property).toBeNull();
    expect((await call("GET", "/api/todo?property=all")).status).toBe(200);
    // The tax report is always for one property.
    const tax = await call("GET", "/api/reports/tax?year=2026&property=all");
    expect(tax.status).toBe(400);
    expect(tax.json.error).toMatch(/one property/);
  });

  it("does the same over MCP", async () => {
    const missing = await mcp("get_summary", { year: 2026 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/property/);
    expect(JSON.parse((await mcp("get_summary", { year: 2026, property: "Cabin" })).text).totals.expense).toBe(60);
    expect(JSON.parse((await mcp("search_transactions", { property: "all" })).text).total).toBe(2);
    const overview = JSON.parse((await mcp("get_overview", {})).text);
    expect(overview.todo.map((t: any) => t.property_id)).toEqual(expect.arrayContaining([first, second]));
    expect((await mcp("get_tax_report", { year: 2026, property: "all" })).isError).toBe(true);
  });

  it('reserves "all" and bare numbers as names', async () => {
    expect((await call("POST", "/api/properties", { name: "All" })).status).toBe(400);
    expect((await call("POST", "/api/properties", { name: "42" })).status).toBe(400);
  });

  it("goes back to the single-property shortcut when the other is archived", async () => {
    await call("PATCH", `/api/properties/${second}`, { address: "1 Lake Rd", building_basis: 1000 });
    const archived = await call("PATCH", `/api/properties/${second}`, { archived: true });
    expect(archived.status).toBe(200);
    // A PATCH changes only what it sends.
    expect(archived.json).toMatchObject({ address: "1 Lake Rd", building_basis: 1000, archived: true });
    expect((await call("GET", "/api/transactions")).json.total).toBe(1);
    expect((await call("PATCH", `/api/properties/${second}`, { archived: false })).status).toBe(200);
  });
});

describe("PATCH", () => {
  it("leaves a category's other settings alone when only its receipt rule changes", async () => {
    const supplies = (await call("GET", "/api/categories")).json.find((c: any) => c.name === "Supplies");
    expect(supplies.default_allocation).toBe("direct");
    const r = await call("PATCH", `/api/categories/${supplies.id}`, { receipt_policy: "always" });
    expect(r.json).toMatchObject({
      receipt_policy: "always",
      default_allocation: "direct",
      schedule_e_line: supplies.schedule_e_line,
    });
  });
});
