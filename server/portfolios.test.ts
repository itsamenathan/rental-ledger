/**
 * Portfolio isolation (docs/plans/portfolios.md). Two portfolios get the same kinds of data; portfolio B's carry
 * "canary" text and an odd amount. Signed in to A, every REST route and MCP tool is called (with B's ids where a route
 * takes one) and nothing may show a canary or change B's rows. List and summary endpoints leak with a 200, so the
 * canaries matter more than the status codes.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-portfolios-"));

const { openDb, setDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { createApp } = await import("./app.ts");
const { inPortfolio } = await import("./portfolio.ts");
const schema = await import("./db/schema.ts");
const ledger = await import("./services/ledger.ts");
const auth = await import("./services/auth.ts");
const rental = await import("./services/rental.ts");
const calendar = await import("./services/calendar.ts");
const ownerStays = await import("./services/owner-stays.ts");
const occCal = await import("./services/occupancy-calendar.ts");
const receipts = await import("./services/receipts.ts");
const recurring = await import("./services/recurring.ts");
const csvImport = await import("./services/csv-import.ts");
const attachments = await import("./services/attachments.ts");
const uploads = await import("./services/uploads.ts");
const cats = await import("./services/categories.ts");
const invites = await import("./services/invites.ts");
const portfolios = await import("./services/portfolios.ts");

const db = openDb(":memory:");
setDb(db);
const app = createApp();

const CANARY = "Canary";
const B_AMOUNT = "4321.09";
/** The same receipt bytes in both portfolios: one stored file, two owners. */
const SHARED_PDF = new TextEncoder().encode("%PDF-1.4\n% the same receipt in both portfolios\n%%EOF\n");

type Actor = import("./context.ts").Actor;
type Ids = Awaited<ReturnType<typeof seedPortfolio>>;

/** One portfolio, every kind of row. `tag` is "Alpha" (A) or "Canary" (B). */
async function seedPortfolio(actor: Actor, tag: string, amount: number) {
  seedDefaults(db);
  const property = ledger.createProperty(db, actor, { name: `${tag} Cottage`, address: `${tag} Lane` });
  ledger.updateProperty(db, actor, ledger.listProperties(db).find((p) => p.name === "My Rental")!.id, {
    archived: true,
  });
  const category = ledger.createCategory(db, actor, { name: `${tag}Category`, kind: "expense" });
  cats.addSubcategory(db, actor, { category: category.id, name: `${tag}SavedSub` });
  const t = ledger.createTransaction(db, actor, {
    property_id: property.id,
    date: "2026-03-14",
    amount: -amount,
    category: category.id,
    subcategory: `${tag}Sub`,
    vendor: `${tag}Vendor`,
    account: `${tag}Acct`,
    description: `${tag} description`,
    reference: `${tag}Ref`,
    // the same ids in both portfolios: unique per portfolio, never across
    external_id: "bank-row-1",
    client_id: "client-id-shared-1",
    needs_review: true,
    review_note: `${tag} review note`,
  });
  const income = ledger.createTransaction(db, actor, {
    property_id: property.id,
    date: "2026-03-20",
    amount: amount,
    category: "Rental Income",
    vendor: `${tag}Guest`,
  });
  const trashed = ledger.createTransaction(db, actor, {
    property_id: property.id,
    date: "2026-03-21",
    amount: -amount,
    category: category.id,
    vendor: `${tag}Trashed`,
  });
  ledger.deleteTransaction(db, actor, trashed.id);
  const attachment = await attachments.addAttachment(db, actor, t.id, {
    filename: `${tag}-receipt.pdf`,
    contentType: "application/pdf",
    data: SHARED_PDF,
  });
  const pending = await uploads.stageUpload(db, actor, {
    filename: `${tag}-pending.pdf`,
    contentType: "application/pdf",
    data: SHARED_PDF,
  });
  const exclusion = receipts.addReceiptExclusion(db, actor, { name: `${tag}Exclude`, note: `${tag} note` });
  const profile = csvImport.saveProfile(db, actor, { name: `${tag}Profile`, headers: [`${tag}Header`], mapping: {} });
  const dismissal = recurring.dismiss(db, actor, {
    series_key: recurring.seriesKey(property.id, category.id, `${tag}Vendor`, `${tag}Sub`),
    month: "2026-02",
    note: `${tag} dismissal`,
  });
  const occupancy = rental.upsertOccupancy(db, actor, {
    property_id: property.id,
    month: "2026-02",
    nights_booked: 11,
    notes: `${tag} occupancy`,
  });
  rental.setTaxYear(db, actor, { property_id: property.id, year: 2026, mortgage_interest: amount, notes: `${tag}Tax` });
  const stay = ownerStays.addOwnerStay(db, actor, {
    property_id: property.id,
    start_date: "2026-04-01",
    end_date: "2026-04-04",
    note: `${tag} stay`,
  });
  const feed = calendar.createFeed(db, actor, { property_id: property.id, name: `${tag}Feed` });
  calendar.syncFeedText(
    db,
    actor,
    feed.id,
    [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      `UID:${tag}-event-1`,
      "DTSTART;VALUE=DATE:20260305",
      "DTEND;VALUE=DATE:20260309",
      "SUMMARY:Reserved",
      `DESCRIPTION:${tag} guest`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
    "2026-11-01",
  );
  const stayDismissal = occCal.dismissCandidate(db, actor, {
    property_id: property.id,
    start_date: "2026-06-01",
    end_date: "2026-06-03",
  });
  const keep = db
    .insert(schema.occupancyCalendarKeeps)
    .values({ propertyId: property.id, month: "2026-01", calendarNights: 3, calendarCheckIns: 1, note: `${tag} keep` })
    .returning()
    .get();
  const stored = db.select().from(schema.attachments).where(eq(schema.attachments.id, attachment.id)).get()!;
  const doc = db
    .insert(schema.managerDocuments)
    .values({
      propertyId: property.id,
      month: "2026-03",
      kind: "invoice",
      filename: `${tag}-invoice.pdf`,
      contentType: "application/pdf",
      size: stored.size,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      text: `${tag} invoice text`,
      reference: `${tag}Inv`,
    })
    .returning()
    .get();
  db.insert(schema.managerAcknowledgements)
    .values({ propertyId: property.id, month: "2026-03", checkKey: "w:abc", note: `${tag} ack` })
    .run();
  const key = auth.createApiKey(db, actor, { name: `${tag}Key`, scope: "write" });
  const invite = invites.createInvite(db, actor, { role: "member", note: `${tag} invitee` });
  const audit = db.select({ id: schema.auditLog.id }).from(schema.auditLog).all().at(-1)!;
  return {
    property: property.id,
    category: category.id,
    transaction: t.id,
    income: income.id,
    trashed: trashed.id,
    attachment: attachment.id,
    pending: pending.id,
    exclusion: exclusion.id,
    profile: profile.id,
    dismissal: dismissal.id,
    occupancy: occupancy.id!,
    stay: stay.stay.id,
    feed: feed.id,
    stayDismissal: stayDismissal.id!,
    keep: keep.id,
    doc: doc.id,
    key: key.key,
    keyId: key.id,
    audit: audit.id,
    invite: invite.id,
  };
}

let A: Ids;
let B: Ids;
let bUserId: number;
const aCookie: Record<string, string> = {};
let viewBeforeB: Map<string, string>;

/** A's queries that don't name anything of B's. */
const A_QUERIES = [
  "",
  "?property=all",
  "?property=all&year=2026",
  "?year=2026",
  "?month=2026-03",
  "?property=all&month=2026-03",
  "?property=all&needs_receipt=true&counts=true",
  "?property=all&from=2026-01-01&to=2026-12-31",
];
/** Reads whose answer changes from one call to the next on its own (they log the reads, or are zips with times). */
const UNSTABLE = (path: string) =>
  path.endsWith(".zip") || ["/api/audit", "/api/api-keys", "/api/auth/me", "/api/backup"].includes(path);

async function mcp(method: string, params: unknown, key = A.key) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.text();
}

type Tool = {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
};
async function mcpTools(): Promise<Tool[]> {
  await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  return JSON.parse(await mcp("tools/list", {})).result.tools as Tool[];
}

/** Every stable REST read and read-only MCP tool, as A sees it now. */
async function viewOfA() {
  const out = new Map<string, string>();
  for (const r of apiRoutes().filter((r) => r.method === "GET" && !r.path.includes(":") && !UNSTABLE(r.path)))
    for (const q of A_QUERIES) {
      const res = await call("GET", r.path + q);
      out.set(`GET ${r.path}${q}`, `${res.status} ${res.text}`);
    }
  for (const tool of await mcpTools()) {
    if (!tool.annotations?.readOnlyHint || /audit/.test(tool.name)) continue;
    for (const args of [{}, { property: "all" }, { property: "all", year: 2026 }, { year: 2026 }])
      out.set(
        `mcp ${tool.name} ${JSON.stringify(args)}`,
        await mcp("tools/call", { name: tool.name, arguments: args }),
      );
  }
  return out;
}

beforeAll(async () => {
  // The server's administrator (first login) is in portfolio 1; A's own admin is not a server administrator.
  const root = await auth.createUser(db, null, {
    email: "root@example.com",
    name: "",
    password: "root password 1",
    role: "admin",
  });
  const aAdmin = await inPortfolio(1, () =>
    auth.createUser(
      db,
      { user: root, apiKeyId: null, canWrite: true, via: "cli" },
      {
        email: "alpha-admin@example.com",
        password: "alpha password 1",
        role: "admin",
        name: "",
      },
    ),
  );
  const actorA: Actor = { user: aAdmin, apiKeyId: null, canWrite: true, via: "web" };
  A = await inPortfolio(1, () => seedPortfolio(actorA, "Alpha", 1234.56));

  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "alpha-admin@example.com", password: "alpha password 1" }),
  });
  expect(login.status).toBe(200);
  aCookie.cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  // What A sees before B exists; B's arrival must not change any of it (totals and counts included).
  viewBeforeB = await viewOfA();

  const p2 = db.insert(schema.portfolios).values({ name: "Canary portfolio", slug: "canaryslug" }).returning().get();
  const bAdmin = await inPortfolio(p2.id, () =>
    auth.createUser(db, null, {
      email: "canary-owner@example.com",
      password: "canary password",
      role: "admin",
      name: "Canary Owner",
    }),
  );
  bUserId = bAdmin.id;
  const actorB: Actor = { user: bAdmin, apiKeyId: null, canWrite: true, via: "web" };
  B = await inPortfolio(p2.id, () => seedPortfolio(actorB, CANARY, Number(B_AMOUNT)));
});

/** Every row of portfolio B, to check nothing A does changes it. */
function snapshotB() {
  const raw = db.$client;
  const bProps = `(SELECT id FROM properties WHERE portfolio_id = 2)`;
  const tables = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
    )
    .all() as { name: string }[];
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    if (["sessions", "file_previews"].includes(name)) continue;
    const cols = (raw.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name);
    const where = cols.includes("portfolio_id")
      ? "portfolio_id = 2"
      : name === "portfolios"
        ? "id = 2"
        : cols.includes("property_id")
          ? `property_id IN ${bProps}`
          : cols.includes("transaction_id")
            ? `transaction_id IN (SELECT id FROM transactions WHERE portfolio_id = 2)`
            : cols.includes("category_id")
              ? `category_id IN (SELECT id FROM categories WHERE portfolio_id = 2)`
              : name === "users"
                ? `id = ${bUserId}`
                : null;
    if (!where) throw new Error(`snapshotB doesn't know how to find portfolio B's rows in ${name}`);
    out[name] = raw
      .prepare(`SELECT * FROM ${name} WHERE ${where} ORDER BY rowid`)
      .all()
      .map((r) => {
        const { last_used_at: _l, ...rest } = r as Record<string, unknown>;
        return rest;
      });
  }
  return JSON.stringify(out);
}

/** Rows of B that differ from a snapshot, readably. */
function changedB(before: string) {
  const a = JSON.parse(before) as Record<string, unknown[]>;
  const b = JSON.parse(snapshotB()) as Record<string, unknown[]>;
  const out: string[] = [];
  for (const t of Object.keys(b)) {
    const was = new Set((a[t] ?? []).map((r) => JSON.stringify(r)));
    const now = new Set(b[t]!.map((r) => JSON.stringify(r)));
    for (const r of now) if (!was.has(r)) out.push(`${t} + ${r.slice(0, 300)}`);
    for (const r of was) if (!now.has(r)) out.push(`${t} - ${r.slice(0, 300)}`);
  }
  return out;
}

const leaks = (body: string) =>
  body.toLowerCase().includes(CANARY.toLowerCase()) ||
  body.includes(B_AMOUNT) ||
  body.includes(B_AMOUNT.replace(".", ""));

/** Which of B's ids a route's `:id` means, by the path segment before it. */
function idsFor(path: string): number[] {
  const seg = path.endsWith("/:id/invites") ? path : path.split("/:id")[0]!;
  const m: Record<string, number[]> = {
    "/api/transactions": [B.transaction, B.income, B.trashed],
    "/api/attachments": [B.attachment],
    "/api/categories": [B.category],
    "/api/properties": [B.property],
    "/api/occupancy": [B.occupancy],
    "/api/occupancy/calendar/keep": [B.keep],
    "/api/owner-stays": [B.stay],
    "/api/owner-stays/dismissals": [B.stayDismissal],
    "/api/calendar/feeds": [B.feed],
    "/api/import/profiles": [B.profile],
    "/api/manager/documents": [B.doc],
    "/api/receipt-exclusions": [B.exclusion],
    "/api/recurring/dismissals": [B.dismissal],
    "/api/uploads": [B.pending],
    "/api/users": [bUserId],
    "/api/api-keys": [B.keyId],
    "/api/audit": [B.audit],
    "/api/invites": [B.invite],
    "/api/admin/portfolios": [2],
    "/api/admin/portfolios/:id/invites": [2],
    "/api/admin/users": [bUserId],
  };
  const ids = m[seg];
  if (!ids) throw new Error(`No portfolio B ids listed for ${path}; add them to idsFor`);
  return ids;
}

/** A small body that passes validation where it can, so the request reaches the lookup. */
const bodyFor = (method: string, path: string) => {
  if (method === "GET" || method === "DELETE") return undefined;
  if (path.includes("/attachments/:id/link")) return { transaction_id: A.transaction };
  if (path.startsWith("/api/transactions/:id/attachments")) return undefined;
  if (path.startsWith("/api/attachments")) return { filename: "renamed.pdf" };
  if (path.startsWith("/api/transactions")) return { description: "changed by A" };
  if (path.startsWith("/api/properties")) return { notes: "changed by A" };
  if (path.startsWith("/api/categories")) return { description: "changed by A" };
  if (path.startsWith("/api/owner-stays")) return { note: "changed by A" };
  if (path.startsWith("/api/calendar/feeds")) return { name: "changed by A" };
  if (path.startsWith("/api/manager/documents")) return { month: "2026-04" };
  if (path.startsWith("/api/users")) return { name: "changed by A" };
  if (path.startsWith("/api/tax-years")) return { property_id: B.property, notes: "changed by A" };
  if (path.startsWith("/api/manager/months")) return { property: B.property, key: "w:abc", note: "changed by A" };
  return {};
};

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = aCookie) {
  const res = await app.request(url, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      origin: "http://localhost",
      host: "localhost",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString("latin1") };
}

const apiRoutes = () => {
  const seen = new Set<string>();
  return app.routes
    .filter((r) => r.path.startsWith("/api/") && !r.path.includes("*") && r.method !== "ALL")
    .filter((r) => {
      const k = `${r.method} ${r.path}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
};

describe("portfolio isolation", () => {
  // First: the later tests call write routes and tools as A, which changes what A sees.
  it("sees exactly what it saw before the other portfolio existed: same totals, counts and lists", async () => {
    const now = await viewOfA();
    const changed = [...viewBeforeB.keys()].filter((k) => now.get(k) !== viewBeforeB.get(k));
    expect(changed).toEqual([]);
    expect(viewBeforeB.size).toBeGreaterThan(200);
  });

  it("shows a portfolio its own canaries (the test can see them at all)", async () => {
    const asB = { authorization: `Bearer ${B.key}` };
    expect(leaks((await call("GET", "/api/transactions?property=all", undefined, asB)).text)).toBe(true);
    expect(leaks((await call("GET", "/api/transactions?property=all")).text)).toBe(false);
  });

  it("keeps ids that are unique per portfolio usable in both", () => {
    const a = db.select().from(schema.transactions).where(eq(schema.transactions.externalId, "bank-row-1")).all();
    expect(a.map((r) => r.portfolioId).sort((x, y) => x - y)).toEqual([1, 2]);
  });

  it("shows nothing of B on any REST read, with or without a property", async () => {
    const before = snapshotB();
    const queries = [
      ...A_QUERIES,
      `?property=${B.property}`,
      `?property_id=${B.property}&year=2026`,
      "?property=all&q=Canary",
      `?property=all&ids=${B.transaction},${B.income}`,
    ];
    const failures: string[] = [];
    for (const r of apiRoutes().filter((r) => r.method === "GET" && !r.path.includes(":"))) {
      for (const q of queries) {
        const res = await call("GET", r.path + q);
        if (leaks(res.text)) failures.push(`GET ${r.path}${q} → ${res.status}: ${res.text.slice(0, 200)}`);
      }
      // B's property by name: unknown here (the error repeats the name that was sent, so check the status)
      const byName = await call("GET", `${r.path}?property=${encodeURIComponent(`${CANARY} Cottage`)}`);
      if (byName.status < 400 && leaks(byName.text))
        failures.push(`GET ${r.path}?property=<B's name> → ${byName.status}`);
    }
    expect(failures).toEqual([]);
    expect(changedB(before)).toEqual([]);
  });

  it("answers every route that takes one of B's ids as if it didn't exist, and changes nothing of B", async () => {
    const before = snapshotB();
    const failures: string[] = [];
    for (const r of apiRoutes().filter((r) => r.path.includes(":"))) {
      const urls: string[] = [];
      if (r.path.includes(":id")) for (const id of idsFor(r.path)) urls.push(r.path.replace(":id", String(id)));
      if (r.path.includes(":year")) urls.push(r.path.replace(":year", "2026") + `?property=${B.property}`);
      if (r.path.includes(":month")) urls.push(r.path.replace(":month", "2026-03") + `?property=${B.property}`);
      for (const url of urls) {
        const res = await call(r.method, url, bodyFor(r.method, r.path));
        // Discarding uploads skips ids that are gone (already saved or discarded), so another portfolio's is a no-op.
        const quietNoOp = r.method === "DELETE" && r.path === "/api/uploads/:id" && res.text === '{"discarded":0}';
        if (leaks(res.text) || (res.status >= 200 && res.status < 300 && !quietNoOp))
          failures.push(`${r.method} ${url} → ${res.status}: ${res.text.slice(0, 200)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(changedB(before)).toEqual([]);
  });

  it("shows nothing of B through any MCP tool, and changes nothing of B", async () => {
    const before = snapshotB();
    const tools = await mcpTools();
    expect(tools.length).toBeGreaterThan(40);
    const bIds = [B.transaction, B.income, B.trashed, B.attachment, B.category, B.occupancy, B.stay, B.feed, B.doc];
    const failures: string[] = [];
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      const variants: Record<string, unknown>[] = [{}, { property: "all" }, { property: B.property }];
      for (const id of bIds)
        variants.push(
          Object.fromEntries(
            props.flatMap((p): [string, unknown][] =>
              p === "id" || p.endsWith("_id")
                ? [[p, id]]
                : p === "ids"
                  ? [[p, [id]]]
                  : p === "property"
                    ? [[p, B.property]]
                    : p === "year"
                      ? [[p, 2026]]
                      : p === "month"
                        ? [[p, "2026-03"]]
                        : [],
            ),
          ),
        );
      for (const args of variants) {
        const text = await mcp("tools/call", { name: tool.name, arguments: args });
        if (leaks(text)) failures.push(`${tool.name}(${JSON.stringify(args)}): ${text.slice(0, 200)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(changedB(before)).toEqual([]);
  });

  it("refuses B's ids sent in a request body, and changes nothing of B", async () => {
    const before = snapshotB();
    const entry = { date: "2026-05-01", amount: -5, property_id: A.property, category: "Cleaning" };
    const attempts: [string, string, unknown][] = [
      ["POST", "/api/transactions/bulk-update", { ids: [B.transaction], patch: { description: "x" } }],
      ["POST", "/api/transactions/bulk-delete", { ids: [B.transaction] }],
      ["POST", "/api/transactions", { ...entry, category: undefined, category_id: B.category }],
      ["POST", "/api/transactions", { ...entry, property_id: B.property }],
      ["POST", "/api/transactions", { ...entry, upload_ids: [B.pending] }],
      ["POST", "/api/transactions/bulk", { transactions: [{ ...entry, property_id: B.property }], dry_run: false }],
      ["PATCH", `/api/transactions/${A.transaction}`, { category_id: B.category }],
      ["PATCH", `/api/transactions/${A.transaction}`, { property_id: B.property }],
      ["PATCH", `/api/attachments/${A.attachment}`, { transaction_id: B.transaction }],
      ["POST", `/api/attachments/${A.attachment}/link`, { transaction_id: B.transaction }],
      ["POST", "/api/subcategories", { category: B.category, name: "x" }],
      ["POST", "/api/subcategories/rename", { category: B.category, from: `${CANARY}Sub`, to: "x" }],
      ["POST", "/api/subcategories/remove", { category: B.category, name: `${CANARY}Sub` }],
      ["PUT", "/api/occupancy", { property_id: B.property, month: "2026-05", nights_booked: 1 }],
      ["POST", "/api/owner-stays", { property_id: B.property, start_date: "2026-08-01", end_date: "2026-08-03" }],
      ["PUT", "/api/tax-years/2025", { property_id: B.property, notes: "x" }],
      ["POST", "/api/calendar/feeds", { property_id: B.property, name: "x" }],
    ];
    const failures: string[] = [];
    for (const [method, url, body] of attempts) {
      const res = await call(method, url, body);
      const created = (res.text.match(/"(created|updated|deleted)":(\d+|\[[^\]]+\])/g) ?? []).filter(
        (m) => !/:0$|:\[\]$/.test(m),
      );
      if (leaks(res.text) || (res.status < 300 && (method !== "POST" || !url.endsWith("/bulk") || created.length)))
        failures.push(`${method} ${url} ${JSON.stringify(body)} → ${res.status}: ${res.text.slice(0, 200)}`);
    }
    expect(failures).toEqual([]);
    expect(changedB(before)).toEqual([]);
    // A replayed save finds the entry of its own portfolio, never the other's with the same client_id.
    const replay = await call("POST", "/api/transactions", { ...entry, client_id: "client-id-shared-1" });
    expect(JSON.parse(replay.text).id).toBe(A.transaction);
  });

  it("lets a person pick only a portfolio they belong to", async () => {
    const res = await call("GET", "/api/transactions?property=all&portfolio=canaryslug");
    expect(res.status).toBe(403);
    expect(leaks(res.text)).toBe(false);
  });

  it("refuses a property or category of another portfolio at the database too", () => {
    expect(() =>
      db
        .insert(schema.transactions)
        .values({ portfolioId: 1, propertyId: B.property, categoryId: A.category, date: "2026-01-01", amountCents: -1 })
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db
        .insert(schema.transactions)
        .values({ portfolioId: 1, propertyId: A.property, categoryId: B.category, date: "2026-01-01", amountCents: -1 })
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

async function loginAs(email: string, password: string) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}
const viewRows = () =>
  db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.portfolioId, 2), eq(schema.auditLog.action, "view")))
    .all();

describe("roles, the server's administrator and invites", () => {
  it("lets the server's administrator look at another portfolio read-only, and records it there once a day", async () => {
    const root = await loginAs("root@example.com", "root password 1");
    const before = snapshotB();
    const read = await call("GET", "/api/transactions?property=all&portfolio=canaryslug", undefined, root);
    expect(read.status).toBe(200);
    expect(leaks(read.text)).toBe(true);
    await call("GET", "/api/overview?portfolio=canaryslug", undefined, root);
    const write = await call(
      "PATCH",
      `/api/transactions/${B.transaction}?portfolio=canaryslug`,
      { description: "root was here" },
      root,
    );
    expect(write.status).toBe(403);
    const me = JSON.parse((await call("GET", "/api/auth/me?portfolio=canaryslug", undefined, root)).text);
    expect(me).toMatchObject({ can_write: false, portfolio: { slug: "canaryslug", role: "viewer", viewing: true } });
    expect(viewRows()).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(snapshotB()).audit_log)).not.toBe(JSON.stringify(JSON.parse(before).audit_log));
    // The B admin sees that entry in their audit log.
    const owner = await loginAs("canary-owner@example.com", "canary password");
    const log = JSON.parse((await call("GET", "/api/audit?limit=5", undefined, owner)).text) as { action: string }[];
    expect(log.some((r) => r.action === "view")).toBe(true);
  });

  it("keeps one portfolio's admin away from a shared login's password, status and role elsewhere", async () => {
    const root: Actor = {
      user: { ...auth.getUser(db, 1), instance_admin: true },
      apiKeyId: null,
      canWrite: true,
      via: "cli",
    };
    const both = await inPortfolio(1, () =>
      auth.createUser(db, root, { email: "both@example.com", name: "", password: "both password 1", role: "member" }),
    );
    portfolios.addMember(db, null, 2, both.id, "admin");
    expect((await call("PATCH", `/api/users/${both.id}`, { password: "taken over!!" })).status).toBe(403);
    expect((await call("PATCH", `/api/users/${both.id}`, { disabled: true })).status).toBe(403);
    expect((await call("PATCH", `/api/users/${both.id}`, { role: "viewer" })).status).toBe(200);
    const roles = db.select().from(schema.memberships).where(eq(schema.memberships.userId, both.id)).all();
    expect(Object.fromEntries(roles.map((m) => [m.portfolioId, m.role]))).toEqual({ 1: "viewer", 2: "admin" });
    expect((await call("DELETE", `/api/users/${both.id}`)).status).toBe(200);
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.userId, both.id)).all()).toHaveLength(1);
    // still signs in, and lands in B (the only portfolio left)
    const s = await loginAs("both@example.com", "both password 1");
    expect(JSON.parse((await call("GET", "/api/auth/me", undefined, s)).text).portfolio.slug).toBe("canaryslug");
  });

  it("never leaves a portfolio without an admin", async () => {
    const aAdmin = db.select().from(schema.users).where(eq(schema.users.email, "alpha-admin@example.com")).get()!;
    // portfolio A has two admins (root and A's own); with root demoted, A's admin is the last one
    expect((await call("PATCH", "/api/users/1", { role: "member" })).status).toBe(200);
    const r = await call("PATCH", `/api/users/${aAdmin.id}`, { role: "member" });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/at least one admin/);
    expect((await call("DELETE", `/api/users/${aAdmin.id}`)).status).toBe(400);
    // nor does disabling the last admin's login
    const root = await loginAs("root@example.com", "root password 1");
    const off = await call("PATCH", `/api/admin/users/${aAdmin.id}`, { disabled: true }, root);
    expect(off.status).toBe(400);
    expect(off.text).toMatch(/only admin of/);
    expect((await call("PATCH", "/api/users/1", { role: "admin" })).status).toBe(200);
    // an admin who isn't the last one can be disabled
    const spare = await inPortfolio(1, () =>
      auth.createUser(
        db,
        { user: { ...auth.getUser(db, 1), instance_admin: true }, apiKeyId: null, canWrite: true, via: "cli" },
        { email: "spare-admin@example.com", name: "", role: "admin" },
      ),
    );
    expect((await call("PATCH", `/api/admin/users/${spare.id}`, { disabled: true }, root)).status).toBe(200);
  });

  it("doesn't show the server administrator's changes to a login in other portfolios' audit logs", async () => {
    const root = await loginAs("root@example.com", "root password 1");
    expect((await call("PATCH", `/api/admin/users/${bUserId}`, { name: "Canary renamed" }, root)).status).toBe(200);
    const asA = await call("GET", "/api/audit?limit=1000");
    expect(leaks(asA.text)).toBe(false);
    // ...but B's own admin sees what happened to their member
    const owner = await loginAs("canary-owner@example.com", "canary password");
    expect((await call("GET", "/api/audit?limit=50", undefined, owner)).text).toContain("Canary renamed");
  });

  it("changes nothing in a portfolio the server's administrator is only looking at", async () => {
    const root = await loginAs("root@example.com", "root password 1");
    await call("GET", "/api/overview?portfolio=canaryslug", undefined, root); // today's view entry, first
    const before = snapshotB();
    const failures: string[] = [];
    const withSlug = (url: string) => `${url}${url.includes("?") ? "&" : "?"}portfolio=canaryslug`;
    // /api/admin/* is the server administrator's own job; /api/auth/* is about the login (and would sign root out)
    const inPortfolioPath = (path: string) => !path.startsWith("/api/admin/") && !path.startsWith("/api/auth/");
    for (const r of apiRoutes().filter((r) => r.method !== "GET" && inPortfolioPath(r.path))) {
      const urls = r.path.includes(":id")
        ? idsFor(r.path).map((id) => r.path.replace(":id", String(id)))
        : [r.path.replace(":year", "2026").replace(":month", "2026-03")];
      for (const url of urls) {
        const res = await call(r.method, withSlug(url), bodyFor(r.method, r.path) ?? {}, root);
        if (res.status === 401)
          failures.push(`${r.method} ${url} → 401: root got signed out, the sweep proves nothing`);
        else if (res.status < 300 && r.path !== "/api/uploads/:id")
          failures.push(`${r.method} ${url} → ${res.status}: ${res.text.slice(0, 160)}`);
      }
    }
    const add = await call(
      "POST",
      withSlug("/api/users"),
      { email: "sneaky@example.com", password: "sneaky password", role: "admin" },
      root,
    );
    if (add.status !== 403) failures.push(`POST /api/users → ${add.status}: ${add.text}`);
    expect(failures).toEqual([]);
    expect(changedB(before)).toEqual([]);
  });

  it("lets the server's administrator add a login into a chosen portfolio, audited there", async () => {
    expect((await call("POST", "/api/admin/users", { email: "x1@example.com", portfolio_id: 2 })).status).toBe(403);
    const root = await loginAs("root@example.com", "root password 1");
    const r = await call(
      "POST",
      "/api/admin/users",
      { email: "helper@example.com", password: "helper password", role: "viewer", portfolio_id: 2 },
      root,
    );
    expect(r.status).toBe(201);
    expect(JSON.parse(r.text).portfolios).toEqual([{ slug: "canaryslug", name: "Canary portfolio", role: "viewer" }]);
    const helper = db.select().from(schema.users).where(eq(schema.users.email, "helper@example.com")).get()!;
    const joined = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entity, "membership"), eq(schema.auditLog.entityId, helper.id)))
      .all();
    expect(joined.map((j) => j.portfolioId)).toEqual([2]);
  });

  it("keeps the server's own activity on the Server pages, out of every portfolio's log", async () => {
    expect((await call("GET", "/api/admin/audit")).status).toBe(403);
    const root = await loginAs("root@example.com", "root password 1");
    const server = JSON.parse((await call("GET", "/api/admin/audit?limit=500", undefined, root)).text) as {
      entity: string;
    }[];
    expect(server.some((r) => r.entity === "portfolio")).toBe(true);
    expect(server.some((r) => r.entity === "transaction")).toBe(false);
    const mine = JSON.parse((await call("GET", "/api/audit?limit=1000", undefined, root)).text) as { entity: string }[];
    expect(mine.some((r) => r.entity === "backup")).toBe(false);
  });

  it("keeps an API key to its own portfolio", async () => {
    const r = await call("GET", "/api/transactions?property=all&portfolio=canaryslug", undefined, {
      authorization: `Bearer ${A.key}`,
    });
    expect(r.status).toBe(403);
    expect(leaks(r.text)).toBe(false);
  });

  it("joins a portfolio with an invite link once, and only that portfolio", async () => {
    const owner = await loginAs("canary-owner@example.com", "canary password");
    const made = JSON.parse((await call("POST", "/api/invites", { role: "viewer", note: "accountant" }, owner)).text);
    expect(made.path).toMatch(/^\/invite\//);
    const token = made.path.split("/").pop();
    const info = JSON.parse((await call("GET", `/api/auth/invites/${token}`, undefined, {})).text);
    expect(info).toMatchObject({ valid: true, portfolio: "Canary portfolio", role: "viewer" });

    const signup = { email: "accountant@example.com", name: "Acc", password: "accountant pw 1" };
    const joined = await app.request(`/api/auth/invites/${token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signup),
    });
    expect(joined.status).toBe(200);
    const cookie = { cookie: joined.headers.get("set-cookie")!.split(";")[0]! };
    const me = JSON.parse((await call("GET", "/api/auth/me", undefined, cookie)).text);
    expect(me).toMatchObject({ can_write: false, portfolio: { slug: "canaryslug", role: "viewer" } });
    // the change history says the person joined themselves, from the web
    const joinedLog = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entity, "membership"), eq(schema.auditLog.entityId, me.user.id)))
      .get()!;
    expect(joinedLog).toMatchObject({ userId: me.user.id, via: "web", portfolioId: 2 });
    expect(leaks((await call("GET", "/api/transactions?property=all", undefined, cookie)).text)).toBe(true);
    const aSlug = db.select().from(schema.portfolios).where(eq(schema.portfolios.id, 1)).get()!.slug;
    expect((await call("GET", `/api/transactions?property=all&portfolio=${aSlug}`, undefined, cookie)).status).toBe(
      403,
    );

    // used once
    const again = await call("POST", `/api/auth/invites/${token}/accept`, { ...signup, email: "x@example.com" }, {});
    expect(again.status).toBe(400);
    // an existing email has to sign in instead
    const second = invites.createInviteFor(
      db,
      { user: { ...auth.getUser(db, 1), instance_admin: true }, apiKeyId: null, canWrite: true, via: "cli" },
      2,
      {},
    );
    const taken = await call(
      "POST",
      `/api/auth/invites/${second.token}/accept`,
      { ...signup, email: "alpha-admin@example.com" },
      {},
    );
    expect(taken.status).toBe(400);
    // signed in, it joins with that login
    const aAdmin = await loginAs("alpha-admin@example.com", "alpha password 1");
    expect((await call("POST", `/api/auth/invites/${second.token}/accept`, {}, aAdmin)).status).toBe(200);
    // already in: refused, and the link stays unused for someone else
    const spare = invites.createInviteFor(
      db,
      { user: { ...auth.getUser(db, 1), instance_admin: true }, apiKeyId: null, canWrite: true, via: "cli" },
      2,
      { role: "admin" },
    );
    const twice = await call("POST", `/api/auth/invites/${spare.token}/accept`, {}, aAdmin);
    expect(twice.status).toBe(400);
    expect(JSON.parse((await call("GET", `/api/auth/invites/${spare.token}`, undefined, {})).text).valid).toBe(true);
    // expired
    const third = invites.createInviteFor(
      db,
      { user: { ...auth.getUser(db, 1), instance_admin: true }, apiKeyId: null, canWrite: true, via: "cli" },
      2,
      {},
    );
    db.update(schema.invites)
      .set({ expiresAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(schema.invites.id, third.id))
      .run();
    expect(JSON.parse((await call("GET", `/api/auth/invites/${third.token}`, undefined, {})).text).valid).toBe(false);
  });

  it("lets only the server's administrator create portfolios, and seeds new ones on their own", async () => {
    expect((await call("POST", "/api/admin/portfolios", { name: "Sneaky" })).status).toBe(403);
    const root = await loginAs("root@example.com", "root password 1");
    const aSlug = db.select().from(schema.portfolios).where(eq(schema.portfolios.id, 1)).get()!.slug;
    const r = await call("POST", "/api/admin/portfolios", { name: "Third portfolio", copy_from: aSlug }, root);
    expect(r.status).toBe(201);
    const p = JSON.parse(r.text);
    const cats3 = db.select().from(schema.categories).where(eq(schema.categories.portfolioId, p.id)).all();
    expect(cats3.some((c) => c.name === "AlphaCategory")).toBe(true);
    expect(cats3.some((c) => c.name === `${CANARY}Category`)).toBe(false);
    // server start-up seeding is a no-op with several portfolios, not an error
    const { seedFirstRun } = await import("./seed.ts");
    expect(() => seedFirstRun(db)).not.toThrow();
  });

  it("downloads everything in one's own portfolio, and nothing of anyone else's", async () => {
    const { readZip } = await import("./services/zip.ts");
    // A's admin joined B by invite earlier in this file, so their session names the portfolio it means
    const aSlug = db.select().from(schema.portfolios).where(eq(schema.portfolios.id, 1)).get()!.slug;
    const download = async (headers: Record<string, string>, query = "") => {
      const res = await app.request(`/api/export/portfolio.zip${query}`, { headers });
      expect(res.status).toBe(200);
      const entries = readZip(Buffer.from(await res.arrayBuffer()));
      const texts = await Promise.all(entries.map(async (e) => `${e.name}\n${(await e.read()).toString("latin1")}`));
      return { names: entries.map((e) => e.name), all: texts.join("\n") };
    };
    const a = await download(aCookie, `?portfolio=${aSlug}`);
    expect(a.names).toEqual(expect.arrayContaining(["Transactions.csv", "Categories.csv", "README.txt"]));
    expect(a.names.some((n) => n.startsWith("Receipts/Alpha Cottage/"))).toBe(true);
    expect(a.all).toContain("AlphaVendor");
    expect(leaks(a.all)).toBe(false);
    const b = await download({ authorization: `Bearer ${B.key}` });
    expect(b.all).toContain(`${CANARY}Vendor`);
    expect(b.all).not.toContain("AlphaVendor");
  });

  it("lets someone leave a portfolio, after which they get a no-access answer", async () => {
    const helper = await loginAs("helper@example.com", "helper password");
    expect((await call("DELETE", "/api/portfolio/membership", undefined, helper)).status).toBe(200);
    const after = await call("GET", "/api/overview", undefined, helper);
    expect(after.status).toBe(403);
    expect(JSON.parse(after.text).details).toEqual({ code: "no_access" });
    const log = JSON.parse(
      (
        await call(
          "GET",
          "/api/audit?limit=20",
          undefined,
          await loginAs("canary-owner@example.com", "canary password"),
        )
      ).text,
    ) as { entity: string; action: string; changes: { left?: boolean } }[];
    expect(log.some((r) => r.entity === "membership" && r.action === "delete" && r.changes?.left)).toBe(true);
  });

  it("tells an agent which portfolio its key works in", async () => {
    await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    const res = JSON.parse(await mcp("tools/call", { name: "get_overview", arguments: {} }));
    const overview = JSON.parse(res.result.content[0].text);
    expect(overview.portfolio).toEqual({
      name: db.select().from(schema.portfolios).where(eq(schema.portfolios.id, 1)).get()!.name,
    });
  });

  it("gives portfolios and properties readable web addresses that renaming keeps", async () => {
    // Filled from the name after migrating (portfolio 1 is made by migration 0017).
    expect(db.select().from(schema.portfolios).where(eq(schema.portfolios.id, 1)).get()!.slug).toBe("my-books");
    const root = await loginAs("root@example.com", "root password 1");
    const made = async (name: string) =>
      JSON.parse((await call("POST", "/api/admin/portfolios", { name }, root)).text).slug;
    expect(await made("Sam's Rentals")).toBe("sams-rentals");
    expect(await made("Sam's rentals")).toBe("sams-rentals-2");
    expect(await made("Settings")).toBe("portfolio-settings");

    const owner = await loginAs("canary-owner@example.com", "canary password");
    const patch = (body: object) => call("PATCH", "/api/portfolio", body, owner);
    // only the server's administrator: a "taken" answer would tell a portfolio admin what other portfolios are called
    expect((await patch({ slug: "my-books" })).status).toBe(403);
    expect(JSON.parse((await patch({ name: "Canary portfolio, renamed" })).text).slug).toBe("canaryslug");
    expect((await patch({})).status).toBe(200);
    await patch({ name: "Canary portfolio" });
    const edit = (slug: string) => call("PATCH", "/api/admin/portfolios/2", { slug }, root);
    for (const slug of ["api", "invite", "transactions", "my-books", "Has Spaces", "1234"])
      expect((await edit(slug)).status, slug).toBe(400);
    expect(JSON.parse((await edit("canary-portfolio")).text).slug).toBe("canary-portfolio");
    expect((await call("GET", "/api/overview?portfolio=canary-portfolio", undefined, owner)).status).toBe(200);
    await edit("canaryslug");

    const key = { authorization: `Bearer ${B.key}` };
    const created = async (body: object) => call("POST", "/api/properties", body, key);
    const cottage = JSON.parse((await created({ name: "Lake & Pines Café" })).text);
    expect(cottage.slug).toBe("lake-and-pines-cafe");
    expect(JSON.parse((await created({ name: "Settings place" })).text).slug).toBe("settings-place");
    expect(JSON.parse((await created({ name: "#1" })).text).slug).toBe("property");
    // per portfolio: A's property's slug is free in B
    const aSlug = inPortfolio(1, () => ledger.listProperties(db)).find((p) => p.id === A.property)?.slug;
    expect(aSlug).toBe("alpha-cottage");
    const renamed = await call("PATCH", `/api/properties/${cottage.id}`, { name: "Lakeside" }, key);
    expect(JSON.parse(renamed.text).slug).toBe("lake-and-pines-cafe");
    for (const slug of ["all", "settings", "p", "42", `${CANARY.toLowerCase()}-cottage`])
      expect((await call("PATCH", `/api/properties/${cottage.id}`, { slug }, key)).status, slug).toBe(400);
    expect((await call("PATCH", `/api/properties/${cottage.id}`, { slug: "alpha-cottage" }, key)).status).toBe(200);
  });

  it("keeps invite tokens out of request logs and traces", async () => {
    const { loggablePath } = await import("./telemetry.ts");
    expect(loggablePath("/invite/abcDEF_123")).toBe("/invite/:token");
    expect(loggablePath("/api/auth/invites/abcDEF_123")).toBe("/api/auth/invites/:token");
    expect(loggablePath("/api/auth/invites/abcDEF_123/accept")).toBe("/api/auth/invites/:token/accept");
    expect(loggablePath("/api/invites/7")).toBe("/api/invites/7");
  });
});
