import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getDb } from "../db.ts";
import { AppError, type Actor } from "../context.ts";
import * as ledger from "../services/ledger.ts";
import * as rental from "../services/rental.ts";
import * as reports from "../services/reports.ts";
import * as recurring from "../services/recurring.ts";
import * as cats from "../services/categories.ts";
import { todoSummary } from "../services/todo.ts";
import { annotate, undoAudit } from "../services/undo.ts";
import * as files from "../services/attachments.ts";
import { listAudit } from "../services/audit.ts";
import type { Env } from "./middleware.ts";

const INSTRUCTIONS = `
Rental property bookkeeping. Data model:
- transactions: date (YYYY-MM-DD, cash basis = date paid), signed amount in dollars (income > 0, expenses < 0),
  category (see list_categories), optional subcategory, vendor/payee, allocation ("direct" | "indirect"), description,
  account, reference (bank memo, used for de-duplication), needs_review flag + review_note.
- Direct expenses relate only to guests/rental activity (cleaning, commissions, management fees, supplies).
  Indirect expenses benefit the whole property (mortgage, insurance, property tax, whole-home repairs) and are
  prorated by rental-use % at tax time. Each expense category has a default allocation; follow it unless the
  user says otherwise.
- occupancy: per-month nights booked, owner (personal) nights, check-ins; drives the rental-use % for taxes.
Guidance for agents:
- Before importing, call bulk_add_transactions with dry_run=true and inspect duplicates/errors.
- When unsure of a category or allocation, still record the transaction but set needs_review=true with a
  review_note explaining the doubt. Never guess silently.
- Recurring bills are learned from history (get_recurring). When the user says a flagged gap is fine or a
  series has ended, record that with dismiss_recurring so it stops being reported.
- Prefer updating an existing transaction over deleting and re-creating it. All writes are audit-logged.
`.trim();

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => {
  const msg = e instanceof z.ZodError ? z.prettifyError(e) : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
};
const wrap =
  <A>(fn: (args: A) => unknown) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

const ref = z.union([z.number().int(), z.string()]);
const txShape = {
  date: z.string().describe("YYYY-MM-DD"),
  amount: z.number().describe("Signed dollars: income positive, expenses NEGATIVE"),
  category: z.string().describe("Category name (see list_categories)"),
  property: ref.optional().describe("Property name or id; defaults to the only property"),
  subcategory: z.string().optional(),
  vendor: z.string().optional().describe("Payee for expenses, payer for income (e.g. Airbnb, VRBO)"),
  allocation: z.enum(["direct", "indirect"]).nullable().optional().describe("Defaults from the category"),
  description: z.string().optional(),
  account: z.string().optional(),
  reference: z.string().optional().describe("Bank description / transaction id"),
  external_id: z.string().optional().describe("Stable unique id from the source; prevents double import"),
  needs_review: z.boolean().optional(),
  review_note: z.string().optional(),
  refund: z.boolean().optional().describe("true if the sign intentionally differs from the category kind"),
};

export function buildMcpServer(actor: Actor) {
  const server = new McpServer({ name: "rental-ledger", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const db = getDb();
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "get_overview",
    {
      description:
        "Properties, categories (with kind/default allocation/Schedule E line), years with data, review queue size and to-do counts. Call this first.",
      inputSchema: {},
      annotations: ro,
    },
    wrap(() => ({
      you: { email: actor.user.email, can_write: actor.canWrite },
      properties: ledger.listProperties(db),
      categories: ledger.listCategories(db, false),
      years: reports.availableYears(db),
      needs_review: ledger.listTransactions(db, { needs_review: "true", limit: 1 }).total,
      todo: (({ alerts: _a, ...counts }) => counts)(todoSummary(db)),
      today: new Date().toISOString().slice(0, 10),
    })),
  );

  server.registerTool(
    "list_categories",
    {
      description: "List transaction categories with their subcategories (and how many transactions use each).",
      inputSchema: { include_archived: z.boolean().optional() },
      annotations: ro,
    },
    wrap(({ include_archived }) => {
      const tree = new Map(cats.categoryTree(db).map((c) => [c.category_id, c]));
      return ledger.listCategories(db, include_archived ?? false).map((c) => ({
        ...c,
        transactions: tree.get(c.id)?.count ?? 0,
        subcategories: tree.get(c.id)?.subcategories ?? [],
      }));
    }),
  );

  server.registerTool(
    "search_transactions",
    {
      description: "Search/filter transactions. Returns items plus totals for the whole filtered set.",
      inputSchema: {
        year: z.number().int().optional(),
        month: z.string().optional().describe("YYYY-MM"),
        from: z.string().optional(),
        to: z.string().optional(),
        property_id: z.number().int().optional(),
        category: z.string().optional(),
        kind: z.enum(["income", "expense"]).optional(),
        allocation: z.enum(["direct", "indirect", "none"]).optional(),
        vendor: z.string().optional(),
        q: z.string().optional().describe("Free-text search"),
        needs_review: z.boolean().optional(),
        has_attachment: z.boolean().optional(),
        amount: z
          .string()
          .optional()
          .describe('Amount search, sign ignored: "69.95", "70" (70.00–70.99), "50-100", ">500", "<20", "~70" (±10%)'),
        min_amount: z.number().optional(),
        max_amount: z.number().optional(),
        sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc", "updated_desc"]).optional(),
        limit: z.number().int().max(1000).optional(),
        offset: z.number().int().optional(),
      },
      annotations: ro,
    },
    wrap((args) => ledger.listTransactions(db, args)),
  );

  server.registerTool(
    "get_transaction",
    {
      description: "Get one transaction with its attachments.",
      inputSchema: { id: z.number().int() },
      annotations: ro,
    },
    wrap(({ id }) => ({ ...ledger.getTransaction(db, id), attachments: files.listAttachments(db, id) })),
  );

  server.registerTool(
    "add_expense",
    {
      description: "Record an expense. Pass the amount PAID as a positive number; it is stored as negative.",
      inputSchema: { ...txShape, amount: z.number().positive().describe("Amount paid, positive dollars") },
    },
    wrap((args) => ledger.createTransaction(db, actor, { ...args, amount: -Math.abs(args.amount) })),
  );

  server.registerTool(
    "add_transaction",
    { description: "Record any transaction with a signed amount (income +, expense −).", inputSchema: txShape },
    wrap((args) => ledger.createTransaction(db, actor, args)),
  );

  server.registerTool(
    "bulk_add_transactions",
    {
      description:
        "Import many transactions at once (e.g. from a bank CSV). Detects duplicates by external_id, or same property+date+amount (+reference). Use dry_run=true first.",
      inputSchema: {
        transactions: z.array(z.object(txShape)).min(1).max(5000),
        dry_run: z.boolean().default(true),
        skip_duplicates: z.boolean().default(true),
        needs_review: z.boolean().optional().describe("Force the review flag on every row"),
      },
    },
    wrap((args) => {
      const r = ledger.bulkCreate(db, actor, args, { source: "mcp" });
      // Keep the response small: only rows that need attention, plus the new ids.
      return {
        ...r,
        results: r.results.filter((x) => x.status === "duplicate" || x.status === "error" || x.duplicate_of?.length),
        created_ids: r.results.flatMap((x) => (x.id ? [x.id] : [])),
      };
    }),
  );

  server.registerTool(
    "update_transaction",
    {
      description:
        "Change fields on a transaction. Only the given fields change. Setting needs_review=false clears the review note.",
      inputSchema: {
        id: z.number().int(),
        ...Object.fromEntries(
          Object.entries(txShape)
            .filter(([k]) => k !== "external_id")
            .map(([k, v]) => [k, (v as z.ZodType).optional()]),
        ),
      },
    },
    wrap(({ id, ...patch }) => ledger.updateTransaction(db, actor, id as number, patch)),
  );

  server.registerTool(
    "bulk_update_transactions",
    {
      description: "Apply the same change to many transactions (e.g. recategorize).",
      inputSchema: {
        ids: z.array(z.number().int()).min(1),
        category: z.string().optional(),
        subcategory: z.string().optional(),
        vendor: z.string().optional(),
        allocation: z.enum(["direct", "indirect"]).nullable().optional(),
        account: z.string().optional(),
        needs_review: z.boolean().optional(),
        review_note: z.string().optional(),
      },
    },
    wrap(({ ids, ...patch }) => ledger.bulkUpdate(db, actor, { ids, patch })),
  );

  server.registerTool(
    "delete_transaction",
    {
      description: "Soft-delete a transaction (restorable from the audit log).",
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true },
    },
    wrap(({ id }) => ledger.deleteTransaction(db, actor, id)),
  );

  server.registerTool(
    "flag_for_review",
    {
      description: "Flag a transaction for human review with a reason.",
      inputSchema: { id: z.number().int(), note: z.string() },
    },
    wrap(({ id, note }) => ledger.updateTransaction(db, actor, id, { needs_review: true, review_note: note })),
  );

  server.registerTool(
    "attach_receipt",
    {
      description:
        "Attach a receipt/invoice file (base64) to a transaction. Allowed: jpeg, png, webp, heic, gif, pdf, txt, csv.",
      inputSchema: {
        transaction_id: z.number().int(),
        filename: z.string(),
        content_type: z.string(),
        content_base64: z.string(),
      },
    },
    wrap(({ transaction_id, filename, content_type, content_base64 }) =>
      files.addAttachment(db, actor, transaction_id, {
        filename,
        contentType: content_type,
        data: Buffer.from(content_base64, "base64"),
      }),
    ),
  );

  server.registerTool(
    "get_summary",
    {
      description:
        "Income/expense totals, monthly breakdown, category and vendor totals, occupancy and year-over-year comparison.",
      inputSchema: { year: z.number().int(), property_id: z.number().int().optional() },
      annotations: ro,
    },
    wrap(({ year, property_id }) => reports.summary(db, year, property_id)),
  );

  server.registerTool(
    "get_tax_report",
    {
      description:
        "Year-end tax report: direct vs indirect expenses, rental-use allocation, Schedule E lines, depreciation estimate, and data-quality checks.",
      inputSchema: { year: z.number().int(), property: ref.optional() },
      annotations: ro,
    },
    wrap(({ year, property }) => reports.taxReport(db, year, property)),
  );

  server.registerTool(
    "list_occupancy",
    {
      description: "Monthly occupancy records.",
      inputSchema: { year: z.number().int().optional(), property_id: z.number().int().optional() },
      annotations: ro,
    },
    wrap((args) => rental.listOccupancy(db, args)),
  );

  server.registerTool(
    "set_occupancy",
    {
      description: "Create or replace a month's occupancy (nights booked, owner/personal nights, check-ins).",
      inputSchema: {
        month: z.string().describe("YYYY-MM"),
        property: ref.optional(),
        nights_available: z.number().int().optional(),
        nights_booked: z.number().int(),
        owner_nights: z.number().int().default(0),
        check_ins: z.number().int().default(0),
        notes: z.string().optional(),
      },
    },
    wrap((args) => rental.upsertOccupancy(db, actor, args)),
  );

  server.registerTool(
    "set_tax_year_inputs",
    {
      description: "Set per-year tax inputs: Form 1098 mortgage interest, and optional rental/personal day overrides.",
      inputSchema: {
        year: z.number().int(),
        property: ref.optional(),
        mortgage_interest: z.number().nullable().optional(),
        rental_days_override: z.number().int().nullable().optional(),
        personal_days_override: z.number().int().nullable().optional(),
        notes: z.string().optional(),
      },
    },
    wrap((args) => rental.setTaxYear(db, actor, args)),
  );

  server.registerTool(
    "add_category",
    {
      description: "Create a category. Ask the user before creating new categories.",
      inputSchema: {
        name: z.string(),
        kind: z.enum(["income", "expense"]),
        default_allocation: z.enum(["direct", "indirect"]).nullable().optional(),
        schedule_e_line: z
          .string()
          .nullable()
          .optional()
          .describe(
            `Schedule E line: ${Object.entries(ledger.SCHEDULE_E_LINES)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}`,
          ),
        description: z.string().optional(),
      },
    },
    wrap((args) => ledger.createCategory(db, actor, args)),
  );

  server.registerTool(
    "month_summary",
    {
      description:
        "One month in detail: income/expenses/net vs previous month, same month last year and 12-month average; totals per category; and the recurring-bill checklist (paid / missing / upcoming).",
      inputSchema: { month: z.string().describe("YYYY-MM"), property: ref.optional() },
      annotations: ro,
    },
    wrap(({ month, property }) =>
      reports.monthDetail(
        db,
        recurring.assertMonth(month),
        property == null ? undefined : ledger.resolvePropertyId(db, property),
      ),
    ),
  );

  server.registerTool(
    "year_totals",
    {
      description: "Income, expenses (direct/indirect), net and nights booked for every year with data.",
      inputSchema: { property: ref.optional() },
      annotations: ro,
    },
    wrap(({ property }) =>
      reports.yearTotals(db, property == null ? undefined : ledger.resolvePropertyId(db, property)),
    ),
  );

  server.registerTool(
    "category_by_month",
    {
      description:
        "Category × month grid for a year (one row per category + subcategory, 12 monthly amounts, year total and prior-year total). Amounts are positive for income and expenses.",
      inputSchema: { year: z.number().int(), property: ref.optional() },
      annotations: ro,
    },
    wrap(({ year, property }) =>
      reports.categoryMonths(db, year, property == null ? undefined : ledger.resolvePropertyId(db, property)),
    ),
  );

  server.registerTool(
    "get_recurring",
    {
      description:
        "Recurring bills/income learned from history (cadence, typical amount, next due date, status) and alerts: missing payments, possible duplicates, amount changes. Use this to answer 'am I missing anything?'.",
      inputSchema: { property: ref.optional(), include_history: z.boolean().default(false) },
      annotations: ro,
    },
    wrap(({ property, include_history }) => {
      const r = recurring.recurring(db, {
        propertyId: property == null ? undefined : ledger.resolvePropertyId(db, property),
      });
      return include_history ? r : { ...r, series: r.series.map(({ history: _h, expected_months: _e, ...s }) => s) };
    }),
  );

  server.registerTool(
    "get_todo",
    {
      description:
        "The user's to-do list: counts of flagged entries, expenses with no direct/indirect set, recurring-bill alerts (missing, duplicate, changed), and $75+ expenses without receipts this year, plus the recurring alerts themselves. Use search_transactions (needs_review=true, allocation=none) for the entries.",
      inputSchema: {},
      annotations: ro,
    },
    wrap(() => todoSummary(db)),
  );

  server.registerTool(
    "dismiss_recurring",
    {
      description:
        "Teach the recurring-bill detector: with a month, mark that month's alert for the series as fine (nothing was due / not a duplicate); without a month, stop tracking the series entirely. Only do this when the user confirms.",
      inputSchema: {
        series_key: z.string().describe("From get_recurring"),
        month: z.string().nullable().optional().describe("YYYY-MM, or omit to ignore the whole series"),
        note: z.string().optional(),
      },
    },
    wrap((args) => recurring.dismiss(db, actor, args)),
  );

  server.registerTool(
    "update_category",
    {
      description:
        "Rename a category or change its default tax treatment / Schedule E line / archived flag. Ask the user first.",
      inputSchema: {
        category: ref.describe("Category name or id"),
        name: z.string().optional(),
        default_allocation: z.enum(["direct", "indirect"]).nullable().optional(),
        schedule_e_line: z.string().nullable().optional(),
        description: z.string().optional(),
        archived: z.boolean().optional(),
      },
    },
    wrap(({ category, ...patch }) => ledger.updateCategory(db, actor, ledger.resolveCategory(db, category).id, patch)),
  );

  server.registerTool(
    "delete_category",
    {
      description:
        "Delete a category (admin only). If it has transactions, move_to names the category that takes them over (merge). Ask the user first.",
      inputSchema: { category: ref, move_to: ref.optional() },
    },
    wrap(({ category, move_to }) =>
      cats.deleteCategoryMoving(db, actor, ledger.resolveCategory(db, category).id, { move_to }),
    ),
  );

  server.registerTool(
    "add_subcategory",
    {
      description: "Save a subcategory under a category so it's offered when adding entries.",
      inputSchema: { category: ref, name: z.string() },
    },
    wrap((args) => cats.addSubcategory(db, actor, args)),
  );

  server.registerTool(
    "rename_subcategory",
    {
      description:
        "Rename a subcategory on every transaction in the category. Renaming onto an existing subcategory merges them. Ask the user first.",
      inputSchema: { category: ref, from: z.string(), to: z.string() },
    },
    wrap((args) => cats.renameSubcategory(db, actor, args)),
  );

  server.registerTool(
    "remove_subcategory",
    {
      description:
        "Remove a subcategory. Its transactions move to move_to (another subcategory) or are left with no subcategory. Ask the user first.",
      inputSchema: { category: ref, name: z.string(), move_to: z.string().optional() },
    },
    wrap((args) => cats.removeSubcategory(db, actor, args)),
  );

  server.registerTool(
    "undo_change",
    {
      description:
        "Reverse one audit-log entry by id (from recent_changes): puts back edited fields, restores deleted transactions, removes added ones, etc. Ask the user first.",
      inputSchema: { audit_id: z.number().int() },
    },
    wrap(({ audit_id }) => undoAudit(db, actor, audit_id)),
  );

  server.registerTool(
    "recent_changes",
    {
      description:
        "Audit log of recent changes (who, via web/api/mcp, what changed). Entries with an `undo` description can be reversed with undo_change.",
      inputSchema: { limit: z.number().int().max(200).default(30), transaction_id: z.number().int().optional() },
      annotations: ro,
    },
    wrap(({ limit, transaction_id }) =>
      annotate(
        db,
        listAudit(db, { limit, entity: transaction_id ? "transaction" : undefined, entity_id: transaction_id }),
      ).map(({ user_id: _u, api_key_id: _k, user_email, api_key_name, ...r }) => ({
        ...r,
        user: user_email,
        api_key: api_key_name,
      })),
    ),
  );

  return server;
}

export const mcpRoutes = new Hono<Env>();

mcpRoutes.all("/", async (c) => {
  const actor = c.get("actor");
  if (!actor || !actor.apiKeyId) {
    c.header("WWW-Authenticate", 'Bearer realm="rental-ledger"');
    throw new AppError(401, "MCP requires an API key: Authorization: Bearer rk_...");
  }
  const server = buildMcpServer({ ...actor, via: "mcp" });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
