import { mkdtempSync, readdirSync } from "node:fs";
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

  it("builds the preparer package for a year", async () => {
    const r = await call("GET", "/api/reports/tax-package.zip?year=2026");
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-disposition")).toContain("2026 tax package.zip");
    const body = Buffer.from(typeof r.json === "string" ? r.json : JSON.stringify(r.json), "latin1");
    expect(body.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);
    expect(body.toString("latin1")).toContain("Summary.txt");
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

function textPdf(lines: string[]) {
  const esc = (s: string) => s.replace(/[()\\]/g, "\\$&");
  const stream = `BT /F1 12 Tf 50 750 Td 14 TL\n${lines.map((l) => `(${esc(l)}) Tj T*`).join("\n")}\nET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe("state tax", () => {
  const tool = async (name: string, args: unknown) => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...bearer(writeKey),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const out: any = await res.json();
    return {
      error: !!out.result.isError,
      data: out.result.isError ? out.result.content[0].text : JSON.parse(out.result.content[0].text),
    };
  };

  it("lists, marks paid, links and clears over REST and MCP", async () => {
    expect((await call("PUT", "/api/state-tax/location", { location_id: "LOC-1" })).json.location_id).toBe("LOC-1");
    const year = await call("GET", "/api/state-tax?year=2025");
    expect(year.status).toBe(200);
    expect(year.json.quarters.map((q: any) => q.due_date)).toEqual([
      "2025-04-20",
      "2025-07-20",
      "2025-10-20",
      "2026-01-20",
    ]);

    const paid = await call("POST", "/api/state-tax/2025/1/paid", { paid_date: "2025-04-15", amount_paid: 12.34 });
    expect(paid.status).toBe(200);
    expect(paid.json.filing).toMatchObject({ amount_paid: 12.34, paid_date: "2025-04-15" });
    const tx = await call("GET", `/api/transactions/${paid.json.filing.transaction_id}`);
    expect(tx.json).toMatchObject({ category: "Taxes", subcategory: "", allocation: "direct", amount: -12.34 });
    const again = await call("POST", "/api/state-tax/2025/1/paid", { paid_date: "2025-04-15", amount_paid: 99 });
    expect(again.status).toBe(409);
    expect(again.json.details.current.amount_paid).toBe(12.34);

    const cleared = await call("DELETE", "/api/state-tax/2025/1/paid");
    expect(cleared.json).toMatchObject({ cleared: true, expense_trashed: false });
    expect((await call("POST", "/api/state-tax/2025/1/link", {})).status).toBe(400);

    // MCP: the kept expense is a candidate, and linking it marks the quarter paid again
    const q = await tool("get_state_tax", { year: 2025, quarter: 1 });
    expect(q.data.candidates.map((c: any) => c.id)).toEqual([paid.json.filing.transaction_id]);
    const linked = await tool("link_state_tax_expense", {
      year: 2025,
      quarter: 1,
      transaction_id: q.data.candidates[0].id,
    });
    expect(linked.data).toMatchObject({ status: "paid", filing: { amount_paid: 12.34 } });
    const viaMcp = await tool("mark_state_tax_paid", {
      year: 2025,
      quarter: 2,
      paid_date: "2025-07-10",
      amount_paid: 5,
    });
    expect(viaMcp.data.status).toBe("paid");
    expect(
      (await tool("clear_state_tax_paid", { year: 2025, quarter: 2, trash_expense: true })).data.expense_trashed,
    ).toBe(true);

    const ro = await call(
      "POST",
      "/api/state-tax/2025/3/paid",
      { paid_date: "2025-10-10", amount_paid: 1 },
      bearer(readKey),
    );
    expect(ro.status).toBe(403);
  });
});

describe("manager statement", () => {
  const csv = [
    'Listing,Guest,Channel,"Check-in date","Check-out date",AcmeOwnerPayout,AcmeCleaningFee,AcmeManagementFee,Nights,"Reservation ID"',
    'Cabin,"Guest A",airbnbOfficial,2027-02-02,2027-02-05,"$1,200.00",$100.00,$90.00,3,R100',
  ].join("\n");
  const pdf = textPdf([
    "Invoice 9",
    "Issued March 3, 2027",
    "ITEM QUANTITY PRICE TOTAL",
    "Management 1 $90.00 $90.00",
    "Cleaning 1 $100.00 $100.00",
    "Subtotal:",
    "Total: $190.00",
  ]);
  const upload = async (files: File[], extra: Record<string, string> = {}, key = writeKey) => {
    const form = new FormData();
    for (const f of files) form.append("file", f);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    const res = await app.request("/api/manager/documents", { method: "POST", headers: bearer(key), body: form });
    return { status: res.status, json: (await res.json()) as any };
  };
  const statementFile = (body = csv) => new File([body], "statement.csv", { type: "text/csv" });
  const invoiceFile = () => new File([pdf], "invoice.pdf", { type: "application/pdf" });

  it("saves uploads under the right month, reviews and applies from them, and attaches the files once", async () => {
    // Invoice first in the upload: statements are still placed first, so the invoice finds its month by fee.
    const up = await upload([invoiceFile(), statementFile()]);
    expect(up.status).toBe(200);
    expect(up.json.map((r: any) => [r.filename, r.status, r.document.kind, r.document.month])).toEqual([
      ["statement.csv", "saved", "statement", "2027-02"],
      ["invoice.pdf", "saved", "invoice", "2027-02"],
    ]);
    expect((await upload([statementFile()])).json[0].status).toBe("duplicate");

    const year = await call("GET", "/api/manager/months?year=2027", undefined, bearer(writeKey));
    const feb = year.json.months.find((m: any) => m.month === "2027-02");
    expect(feb).toMatchObject({ status: "todo", to_add: 3, statement: { filename: "statement.csv" } });
    expect(year.json.months.find((m: any) => m.month === "2027-03").status).toBe("empty");

    const p = (await call("GET", "/api/manager/months/2027-02?subcategory=Acme", undefined, bearer(writeKey))).json;
    expect(p.documents).toHaveLength(2);
    expect(p.lines.map((l: any) => [l.key, l.category, l.status])).toEqual([
      ["9#0", "Management Fee", "missing"],
      ["9#1", "Cleaning", "missing"],
    ]);
    const apply = () =>
      call(
        "POST",
        "/api/manager/months/2027-02/apply",
        { subcategory: "Acme", create_income: ["R100"], create_lines: ["9#0", "9#1"] },
        bearer(writeKey),
      );
    const done = await apply();
    expect(done.status).toBe(200);
    expect(done.json.created_expenses).toHaveLength(2);
    expect(done.json.created_income).toHaveLength(1);
    const mgmt = done.json.anchor_transaction_id;
    const names = async (txId: number) =>
      (await call("GET", `/api/transactions/${txId}/attachments`, undefined, bearer(writeKey))).json.map(
        (a: any) => a.filename,
      );
    expect(await names(mgmt)).toEqual(["invoice.pdf", "statement.csv"]);
    expect(await names(done.json.created_expenses[1])).toEqual(["invoice.pdf"]);
    const again = await apply();
    expect(again.json.created_expenses).toEqual([]);
    expect(await names(mgmt)).toEqual(["invoice.pdf", "statement.csv"]); // not attached twice

    // The invoice file is shared by the document and the attachments: deleting either keeps the other readable.
    const atts = (await call("GET", `/api/transactions/${mgmt}/attachments`, undefined, bearer(writeKey))).json;
    await call("DELETE", `/api/attachments/${atts[0].id}`, undefined, bearer(writeKey));
    const invDoc = p.documents.find((d: any) => d.kind === "invoice");
    const file = await app.request(`/api/manager/documents/${invDoc.id}/file`, { headers: bearer(writeKey) });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect((await call("DELETE", `/api/manager/documents/${invDoc.id}`, undefined, bearer(writeKey))).status).toBe(200);
    const other = (
      await call("GET", `/api/transactions/${done.json.created_expenses[1]}/attachments`, undefined, bearer(writeKey))
    ).json;
    expect((await app.request(`/api/attachments/${other[0].id}`, { headers: bearer(writeKey) })).status).toBe(200);
  });

  it("reports a different file for an occupied month as a conflict, replaces on request, and can move a document", async () => {
    const changed = csv.replace("$1,200.00", "$1,250.00");
    const conflict = (await upload([statementFile(changed)])).json[0];
    expect(conflict).toMatchObject({ status: "conflict", existing: { month: "2027-02" } });
    const replaced = (await upload([statementFile(changed)], { replace: "true" })).json[0];
    expect(replaced).toMatchObject({ status: "replaced", document: { month: "2027-02" } });
    const moved = await call(
      "PATCH",
      `/api/manager/documents/${replaced.document.id}`,
      { month: "2027-04" },
      bearer(writeKey),
    );
    expect(moved.json.month).toBe("2027-04");
    expect((await upload([new File(["hello"], "notes.txt", { type: "text/plain" })])).json[0].status).toBe("error");
    expect((await upload([statementFile()], {}, readKey)).status).toBe(403);
  });
});

describe("attachment storage", () => {
  const upload = async (txId: number, name: string, body: string) => {
    const form = new FormData();
    form.append("file", new File([body], name, { type: "text/plain" }));
    const res = await app.request(`/api/transactions/${txId}/attachments`, {
      method: "POST",
      headers: bearer(writeKey),
      body: form,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: number }[])[0]!;
  };
  const storedFiles = () => {
    const root = join(process.env.DATA_DIR!, "uploads");
    try {
      return readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
    } catch {
      return 0;
    }
  };

  it("stores identical files once, ignores repeats on one entry, and deletes the file with its last reference", async () => {
    const mk = async () =>
      (
        await call(
          "POST",
          "/api/transactions",
          { date: "2027-05-01", amount: -5, category: "Supplies" },
          bearer(writeKey),
        )
      ).json.id as number;
    const [a, b] = [await mk(), await mk()];
    const before = storedFiles();

    const first = await upload(a, "invoice.txt", "same bytes");
    const again = await upload(a, "invoice-copy.txt", "same bytes");
    expect(again.id).toBe(first.id); // same entry + same bytes: no new row
    const other = await upload(b, "invoice.txt", "same bytes");
    expect(other.id).not.toBe(first.id); // each entry keeps its own attachment row
    expect(storedFiles()).toBe(before + 1); // ...but only one stored file

    await upload(b, "different.txt", "other bytes");
    expect(storedFiles()).toBe(before + 2);

    expect((await call("DELETE", `/api/attachments/${first.id}`, undefined, bearer(writeKey))).status).toBe(200);
    const kept = await app.request(`/api/attachments/${other.id}`, { headers: bearer(writeKey) });
    expect(await kept.text()).toBe("same bytes"); // still readable through the other entry
    expect((await call("DELETE", `/api/attachments/${other.id}`, undefined, bearer(writeKey))).status).toBe(200);
    expect(storedFiles()).toBe(before + 1);
  });
});

describe("offline outbox replay", () => {
  it("returns the saved entry when the same client_id is sent again", async () => {
    const entry = {
      date: "2026-03-04",
      amount: -42.5,
      category: "Supplies",
      vendor: "Hardware store",
      client_id: "c0ffee00-0000-4000-8000-000000000001",
    };
    const first = await call("POST", "/api/transactions", entry);
    expect(first.status).toBe(201);
    const again = await call("POST", "/api/transactions", { ...entry, amount: -99 });
    expect(again.status).toBe(201);
    expect(again.json.id).toBe(first.json.id);
    expect(again.json.amount).toBe(-42.5);
    const list = await call("GET", "/api/transactions?q=Hardware%20store");
    expect(list.json.items.filter((t: { id: number }) => t.id === first.json.id)).toHaveLength(1);
    expect(list.json.total).toBe(1);
    const audit = await call("GET", `/api/audit?entity=transaction&entity_id=${first.json.id}`);
    expect(audit.json).toHaveLength(1);
  });
});

describe("offline edits", () => {
  it("refuses an update or delete made against an older copy", async () => {
    const made = await call("POST", "/api/transactions", { date: "2026-03-05", amount: -20, category: "Supplies" });
    const base = made.json.updated_at as string;
    const first = await call("PATCH", `/api/transactions/${made.json.id}`, {
      vendor: "Corner store",
      expected_updated_at: base,
    });
    expect(first.status).toBe(200);
    expect(first.json.updated_at).not.toBe(base);

    const stale = await call("PATCH", `/api/transactions/${made.json.id}`, {
      description: "from the phone",
      expected_updated_at: base,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.details.current.vendor).toBe("Corner store");
    expect(stale.json.details.current.description).toBe("");

    const del = await call(
      "DELETE",
      `/api/transactions/${made.json.id}?expected_updated_at=${encodeURIComponent(base)}`,
    );
    expect(del.status).toBe(409);
    const ok = await call(
      "DELETE",
      `/api/transactions/${made.json.id}?expected_updated_at=${encodeURIComponent(first.json.updated_at)}`,
    );
    expect(ok.status).toBe(200);
  });
});

describe("downloads", () => {
  it("serves files whose names aren't Latin-1", async () => {
    const t = await call(
      "POST",
      "/api/transactions",
      { date: "2026-02-01", amount: -12, category: "Supplies", vendor: "Shop" },
      bearer(writeKey),
    );
    expect(t.status).toBe(201);
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], '收据 "café" 🧾.png', { type: "image/png" }));
    const up = await app.request(`/api/transactions/${t.json.id}/attachments`, {
      method: "POST",
      headers: bearer(writeKey),
      body: form,
    });
    expect(up.status).toBe(201);
    const [att] = (await up.json()) as any[];
    const res = await app.request(`/api/attachments/${att.id}`, { headers: bearer(writeKey) });
    expect(res.status).toBe(200);
    const header = res.headers.get("content-disposition")!;
    expect(header).toMatch(/^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    expect(decodeURIComponent(header.split("UTF-8''")[1]!)).toBe(att.filename);
  });
});
