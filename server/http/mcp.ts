import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getDb } from "../db.ts";
import { AppError, type Actor } from "../context.ts";
import * as ledger from "../services/ledger.ts";
import * as rental from "../services/rental.ts";
import * as calendar from "../services/calendar.ts";
import * as ownerStays from "../services/owner-stays.ts";
import * as occCal from "../services/occupancy-calendar.ts";
import * as reports from "../services/reports.ts";
import * as recurring from "../services/recurring.ts";
import * as cats from "../services/categories.ts";
import * as receipts from "../services/receipts.ts";
import { todoSummary } from "../services/todo.ts";
import { annotate, undoAudit } from "../services/undo.ts";
import { withSpan } from "../telemetry.ts";
import * as files from "../services/attachments.ts";
import * as library from "../services/files.ts";
import * as manager from "../services/manager-statement.ts";
import * as docs from "../services/manager-documents.ts";
import * as csvImport from "../services/csv-import.ts";
import { listAudit } from "../services/audit.ts";
import { currentPortfolio } from "../services/portfolios.ts";
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
- occupancy: per-month nights booked, owner (personal) nights, check-ins; drives the rental-use % for taxes. It is
  the record: nothing writes to it on its own.
- owner stays: personal-use stays by date (owner, family, below-market; end_date = checkout day, not counted). For
  a month with any stay night, owner_nights comes from the stays (owner_nights_source "stays") and a typed
  owner_nights is ignored; other months keep the typed number.
- booking calendar: availability imported from Airbnb/VRBO iCal feeds (reservations and blocked dates), plus past
  stays from an imported reservations export and from saved manager statements (feeds forget old stays). It misses
  direct/off-platform bookings, and an owner stay shows only as a block, so don't treat it as the occupancy record.
  list_owner_stay_candidates suggests blocks that may be owner stays and compare_occupancy_calendar compares guest
  nights; ask the user before add_owner_stay / apply_calendar_to_occupancy.
- properties: each rental is separate. Transactions, occupancy, booking calendars, tax-year inputs and manager
  paperwork all belong to one property; categories, receipt rules and import profiles are shared by the properties
  of the portfolio. This API key only ever sees its own portfolio (get_overview names it); "all" means all of its
  properties. Someone with several portfolios has a separate key for each.
Picking a property:
- get_overview lists the properties. Pass \`property\` (name or id) to every tool that takes one. It may be left
  out only while there is a single active property; with several, a missing property is an error, never a guess.
- Read tools that total things up (search_transactions, get_summary, month_summary, year_totals, category_by_month,
  get_recurring, get_todo, list_files, list_occupancy) also accept property="all" to add up every property. The
  tax report, calendar, occupancy edits, tax-year inputs and manager paperwork are always per property.
Guidance for agents:
- Before importing, call bulk_add_transactions with dry_run=true and inspect duplicates/errors.
- For a bank/card/provider CSV, use inspect_csv (suggests a column mapping, or a saved profile) then
  preview_csv_import, which flags rows already in the ledger (duplicate) or probably there (possible: same amount
  within a few days). Show possible matches to the user before adding them.
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
/** A single property (writes and per-property reads). */
const one = ref
  .optional()
  .describe("Property name or id (see get_overview). May be left out only while there is one active property.");
/** Reads that can also add up every property. */
const scope = ref
  .optional()
  .describe(
    'Property name or id, or "all" to add up every property. May be left out only while there is one active property.',
  );
const receiptFields = {
  receipt_policy: z
    .enum(["always", "threshold", "never"])
    .optional()
    .describe(
      "When to ask for a receipt: always (any amount), threshold (at least receipt_min, default) or never. New Schedule E line 12 (mortgage) categories default to never.",
    ),
  receipt_min: z
    .number()
    .positive()
    .nullable()
    .optional()
    .describe("Dollar threshold for 'threshold'; null = app default ($75)"),
};
const txShape = {
  date: z.string().describe("YYYY-MM-DD"),
  amount: z.number().describe("Signed dollars: income positive, expenses NEGATIVE"),
  category: z.string().describe("Category name (see list_categories)"),
  property: one,
  subcategory: z.string().optional(),
  vendor: z.string().optional().describe("Payee for expenses, payer for income (e.g. Airbnb, VRBO)"),
  allocation: z.enum(["direct", "indirect"]).nullable().optional().describe("Defaults from the category"),
  description: z.string().optional(),
  account: z.string().optional(),
  reference: z.string().optional().describe("Bank description / transaction id"),
  external_id: z.string().optional().describe("Stable unique id from the source; prevents double import"),
  client_id: z
    .string()
    .optional()
    .describe("Idempotency key: retrying with the same client_id returns the entry already saved"),
  needs_review: z.boolean().optional(),
  review_note: z.string().optional(),
  refund: z.boolean().optional().describe("true if the sign intentionally differs from the category kind"),
};

export function buildMcpServer(actor: Actor) {
  const server = new McpServer({ name: "rental-ledger", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const db = getDb();
  const ro = { readOnlyHint: true, openWorldHint: false };
  // A span per tool call (name, caller) so agent activity shows up in traces.
  const register = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (
    name: string,
    cfg: unknown,
    cb: (...a: unknown[]) => unknown,
  ) =>
    register(name, cfg, (...args: unknown[]) =>
      withSpan(`mcp.tool ${name}`, { "mcp.tool.name": name, "enduser.id": String(actor.user.id) }, () => cb(...args)),
    );

  server.registerTool(
    "get_overview",
    {
      description:
        "Which portfolio this key works in, its properties, categories (with kind/default allocation/Schedule E line), years with data, and each active property's to-do counts (flagged = review queue). Call this first, and pick the property to work on from here.",
      inputSchema: {},
      annotations: ro,
    },
    wrap(() => {
      const properties = ledger.listProperties(db);
      return {
        you: { email: actor.user.email, role: actor.user.role, can_write: actor.canWrite },
        /** The portfolio this API key belongs to; everything below is in it only. */
        portfolio: { name: currentPortfolio(db).name },
        properties,
        categories: ledger.listCategories(db, false),
        years: reports.availableYears(db),
        todo: properties
          .filter((p) => !p.archived)
          .map((p) => {
            const {
              alerts: _a,
              manager_months: _m,
              occupancy_items: _o,
              ...counts
            } = todoSummary(db, { propertyId: p.id });
            return { property_id: p.id, property: p.name, ...counts };
          }),
        today: new Date().toISOString().slice(0, 10),
      };
    }),
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
        property: scope,
        ids: z.array(z.number().int()).max(500).optional().describe("Only these entries"),
        category: z.string().optional(),
        kind: z.enum(["income", "expense"]).optional(),
        allocation: z.enum(["direct", "indirect", "none"]).optional(),
        vendor: z.string().optional(),
        q: z.string().optional().describe("Free-text search"),
        needs_review: z.boolean().optional(),
        has_attachment: z.boolean().optional(),
        needs_receipt: z
          .boolean()
          .optional()
          .describe("true = expenses that should have a receipt and don't (category receipt rules + never-ask names)"),
        amount: z
          .string()
          .optional()
          .describe('Amount search, sign ignored: "69.95", "70" (70.00–70.99), "50-100", ">500", "<20", "~70" (±10%)'),
        min_amount: z.number().optional(),
        max_amount: z.number().optional(),
        sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc", "updated_desc"]).optional(),
        counts: z
          .boolean()
          .optional()
          .describe(
            "true = also return counts (all/income/expense/needs_review/needs_receipt) under the other filters",
          ),
        limit: z.number().int().max(1000).optional(),
        offset: z.number().int().optional(),
      },
      annotations: ro,
    },
    wrap(({ property, ...args }) =>
      ledger.listTransactions(db, { ...args, property_id: ledger.resolvePropertyScope(db, property) }),
    ),
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
            .filter(([k]) => k !== "external_id" && k !== "client_id")
            .map(([k, v]) => [k, (v as z.ZodType).optional()]),
        ),
        expected_updated_at: z
          .string()
          .optional()
          .describe("updated_at from when you read it; refused if the entry changed since"),
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
      inputSchema: {
        id: z.number().int(),
        expected_updated_at: z
          .string()
          .optional()
          .describe("updated_at from when you read it; refused if the entry changed since"),
      },
      annotations: { destructiveHint: true },
    },
    wrap(({ id, expected_updated_at }) => ledger.deleteTransaction(db, actor, id, expected_updated_at)),
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
    "list_files",
    {
      description:
        "List stored files (receipts on entries and saved manager statements/invoices) for a month or year, each with the entries it is attached to, plus expenses that should have a receipt and have no file (category receipt rules and never-ask names). One item per stored file even when attached to several entries.",
      inputSchema: {
        month: z.string().optional().describe("YYYY-MM (default: current year if neither is given)"),
        year: z.number().int().optional(),
        property: scope,
        q: z.string().optional().describe("Match file name, vendor, category, subcategory, description, reference"),
        source: z.enum(["all", "receipts", "manager"]).optional(),
      },
      annotations: ro,
    },
    wrap(({ property, ...args }) =>
      library.listFiles(db, { ...args, property_id: ledger.resolvePropertyScope(db, property) }),
    ),
  );

  server.registerTool(
    "update_attachment",
    {
      description:
        "Rename an attachment and/or move it to another transaction. If the target already has the same file, the moved copy is dropped.",
      inputSchema: {
        id: z.number().int().describe("Attachment id (links[].attachment_id from list_files)"),
        filename: z.string().optional(),
        transaction_id: z.number().int().optional().describe("Move to this transaction"),
      },
    },
    wrap(({ id, ...patch }) => files.updateAttachment(db, actor, id, patch)),
  );

  server.registerTool(
    "link_attachment",
    {
      description:
        "Attach an existing file to another transaction as well (e.g. one receipt covering two entries). The file is shared, not copied. Remove a link with unlink_attachment.",
      inputSchema: {
        id: z.number().int().describe("Attachment id (links[].attachment_id from list_files)"),
        transaction_id: z.number().int(),
      },
    },
    wrap(({ id, transaction_id }) => files.linkAttachment(db, actor, id, { transaction_id })),
  );

  server.registerTool(
    "unlink_attachment",
    {
      description:
        "Take a file off one transaction (by attachment id). The file is deleted only when nothing else uses it: no other transaction and no saved manager document.",
      inputSchema: { id: z.number().int().describe("Attachment id (links[].attachment_id from list_files)") },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ id }) => {
      await files.deleteAttachment(db, actor, id);
      return { ok: true };
    }),
  );

  server.registerTool(
    "get_summary",
    {
      description:
        "Income/expense totals, monthly breakdown, category and vendor totals, occupancy and year-over-year comparison.",
      inputSchema: { year: z.number().int(), property: scope },
      annotations: ro,
    },
    wrap(({ year, property }) => reports.summary(db, year, ledger.resolvePropertyScope(db, property))),
  );

  server.registerTool(
    "get_tax_report",
    {
      description:
        "Year-end tax report: direct vs indirect expenses, rental-use allocation, Schedule E lines, depreciation estimate, and data-quality checks.",
      inputSchema: { year: z.number().int(), property: one },
      annotations: ro,
    },
    wrap(({ year, property }) => reports.taxReport(db, year, property)),
  );

  server.registerTool(
    "list_occupancy",
    {
      description: "Monthly occupancy records.",
      inputSchema: { year: z.number().int().optional(), property: scope },
      annotations: ro,
    },
    wrap(({ year, property }) =>
      rental.listOccupancy(db, { year, property_id: ledger.resolvePropertyScope(db, property) }),
    ),
  );

  server.registerTool(
    "set_occupancy",
    {
      description: "Create or replace a month's occupancy (nights booked, owner/personal nights, check-ins).",
      inputSchema: {
        month: z.string().describe("YYYY-MM"),
        property: one,
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
    "list_owner_stays",
    {
      description:
        "Personal-use stays by date (owner, family, below-market) with nights and nights_in_year. end_date is the " +
        "checkout day (not counted).",
      inputSchema: { year: z.number().int().optional(), property: scope },
      annotations: ro,
    },
    wrap(({ year, property }) =>
      ownerStays.listOwnerStays(db, { year, property_id: ledger.resolvePropertyScope(db, property) }),
    ),
  );

  server.registerTool(
    "add_owner_stay",
    {
      description:
        "Record a personal-use stay by date. Its nights become that month's owner (personal) nights, split by each " +
        "night's date across months and years. Rejects overlaps with another stay; returns warnings when it " +
        "overlaps guest reservations on the calendar.",
      inputSchema: {
        property: one,
        start_date: z.string().describe("First night, YYYY-MM-DD"),
        end_date: z.string().describe("Checkout day, YYYY-MM-DD (not counted)"),
        kind: z.enum(ownerStays.OWNER_STAY_KINDS).optional(),
        note: z.string().optional(),
      },
    },
    wrap((args) => ownerStays.addOwnerStay(db, actor, args)),
  );

  server.registerTool(
    "update_owner_stay",
    {
      description: "Change an owner stay's dates, kind or note.",
      inputSchema: {
        id: z.number().int(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        kind: z.enum(ownerStays.OWNER_STAY_KINDS).nullable().optional(),
        note: z.string().optional(),
      },
    },
    wrap(({ id, ...patch }) => ownerStays.updateOwnerStay(db, actor, id, patch)),
  );

  server.registerTool(
    "delete_owner_stay",
    {
      description: "Delete an owner stay. A month left with no stays goes back to its typed owner nights.",
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true },
    },
    wrap(({ id }) => ownerStays.deleteOwnerStay(db, actor, id)),
  );

  server.registerTool(
    "list_owner_stay_candidates",
    {
      description:
        "Blocked calendar ranges in a year with no guest reservation from any source, that may be owner stays. " +
        "signal: strong (blocked on every calendar that reaches back that far), unclear (only one calendar can " +
        "tell), weak (open on another calendar, a one-night turnover block, or a long closure). Nothing counts until " +
        "the user confirms: add_owner_stay with the range, or dismiss_owner_stay_candidate.",
      inputSchema: { year: z.number().int(), property: one },
      annotations: ro,
    },
    wrap(({ year, property }) => occCal.ownerStayCandidates(db, { property_id: property, year })),
  );

  server.registerTool(
    "dismiss_owner_stay_candidate",
    {
      description: 'Remember that a suggested blocked range is not an owner stay ("Not a stay").',
      inputSchema: { property: one, start_date: z.string(), end_date: z.string() },
    },
    wrap((args) => occCal.dismissCandidate(db, actor, args)),
  );

  server.registerTool(
    "compare_occupancy_calendar",
    {
      description:
        "For each month of a year: the calendar's guest nights and check-ins vs the saved occupancy. Only months " +
        'that have ended and have at least one calendar reservation are compared (otherwise status "not_ended" or ' +
        '"no_data", which is not zero). calendar_lower means the calendar has fewer nights than saved, possibly a ' +
        "direct booking it doesn't know about. Months that differ list the reservations counted (stays) and kept " +
        "(non-null when the user said to keep the saved numbers; those aren't asked about again).",
      inputSchema: { year: z.number().int(), property: one },
      annotations: ro,
    },
    wrap(({ year, property }) => occCal.compareOccupancyCalendar(db, { property_id: property, year })),
  );

  server.registerTool(
    "apply_calendar_to_occupancy",
    {
      description:
        "Copy the calendar's guest nights and check-ins into the saved occupancy for the given months (owner nights, " +
        "available nights and notes are kept). Months where the calendar is lower are skipped unless " +
        "confirm_lower=true, which needs the user's explicit OK for those months.",
      inputSchema: {
        property: one,
        months: z.array(z.string()).describe("YYYY-MM"),
        confirm_lower: z.boolean().optional(),
      },
    },
    wrap((args) => occCal.applyCalendarToOccupancy(db, actor, args)),
  );

  server.registerTool(
    "keep_occupancy_numbers",
    {
      description:
        "Keep the saved guest nights of a month whose calendar numbers differ (for example a direct booking the " +
        "calendar doesn't know), so it stops showing on the To do list. Asked again if either side's numbers change. " +
        "Only with the user's OK.",
      inputSchema: {
        property: one,
        month: z.string().describe("YYYY-MM"),
        note: z.string().optional().describe("Why the saved numbers are right"),
      },
    },
    wrap((args) => occCal.keepOccupancyNumbers(db, actor, args)),
  );

  server.registerTool(
    "get_calendar",
    {
      description:
        "Booking calendar for whole months: reservations and blocks from the iCal feeds, past stays from imported " +
        "reservation history and saved manager statements (each event has a source), which event holds each night " +
        "(a reservation beats a block), and per-month booked/blocked/free nights and check-ins.",
      inputSchema: {
        from_month: z.string().describe("YYYY-MM"),
        to_month: z.string().optional().describe("YYYY-MM, default from_month"),
        property: one,
      },
      annotations: ro,
    },
    wrap(({ property, ...args }) =>
      calendar.getCalendar(db, actor, { ...args, property_id: ledger.resolvePropertyId(db, property) }),
    ),
  );

  server.registerTool(
    "list_calendar_feeds",
    {
      description: "iCal feeds imported into the booking calendar, with last sync and error.",
      inputSchema: { property: scope },
      annotations: ro,
    },
    wrap(({ property }) => calendar.listFeeds(db, actor, { property_id: ledger.resolvePropertyScope(db, property) })),
  );

  server.registerTool(
    "add_calendar_feed",
    {
      description: "Add an iCal export link (Airbnb/VRBO) to import into the booking calendar, then sync it.",
      inputSchema: { name: z.string(), url: z.string(), property: one },
    },
    wrap(async (args) => {
      const feed = calendar.createFeed(db, actor, args);
      return { feed, sync: await calendar.refreshFeed(db, actor, feed.id) };
    }),
  );

  server.registerTool(
    "refresh_calendar_feeds",
    {
      description: "Download linked iCal feeds now and update the calendar (one feed by id, or all).",
      inputSchema: { feed_id: z.number().int().optional() },
    },
    wrap(async ({ feed_id }) =>
      feed_id ? [await calendar.refreshFeed(db, actor, feed_id)] : calendar.refreshFeeds(db, actor),
    ),
  );

  server.registerTool(
    "import_reservation_history",
    {
      description:
        "Add past stays to the booking calendar from a reservations export CSV (Airbnb: Reservations → Export to " +
        "CSV; needs start and end date columns, uses the confirmation code to update on re-import). Cancelled " +
        "requests and stays that haven't ended are skipped (the iCal feed covers those). With several listings in " +
        "the file, pass `listing`. Use dry_run=true first.",
      inputSchema: {
        csv: z.string(),
        listing: z.string().optional(),
        dry_run: z.boolean().optional(),
        property: one,
      },
    },
    wrap((args) => calendar.importReservationHistory(db, actor, args)),
  );

  server.registerTool(
    "clear_reservation_history",
    {
      description: "Remove every stay imported with import_reservation_history for one property.",
      inputSchema: { property: one },
      annotations: { destructiveHint: true },
    },
    wrap(({ property }) => calendar.clearHistory(db, actor, { property_id: ledger.resolvePropertyId(db, property) })),
  );

  server.registerTool(
    "set_tax_year_inputs",
    {
      description: "Set per-year tax inputs: Form 1098 mortgage interest, and optional rental/personal day overrides.",
      inputSchema: {
        year: z.number().int(),
        property: one,
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
        ...receiptFields,
      },
    },
    wrap((args) => ledger.createCategory(db, actor, args)),
  );

  server.registerTool(
    "month_summary",
    {
      description:
        "One month in detail: income/expenses/net vs previous month, same month last year and 12-month average; totals per category; and the recurring-bill checklist (paid / missing / upcoming).",
      inputSchema: { month: z.string().describe("YYYY-MM"), property: scope },
      annotations: ro,
    },
    wrap(({ month, property }) =>
      reports.monthDetail(db, recurring.assertMonth(month), ledger.resolvePropertyScope(db, property)),
    ),
  );

  server.registerTool(
    "year_totals",
    {
      description: "Income, expenses (direct/indirect), net and nights booked for every year with data.",
      inputSchema: { property: scope },
      annotations: ro,
    },
    wrap(({ property }) => reports.yearTotals(db, ledger.resolvePropertyScope(db, property))),
  );

  server.registerTool(
    "category_by_month",
    {
      description:
        "Category × month grid for a year (one row per category + subcategory, 12 monthly amounts, year total and prior-year total). Amounts are positive for income and expenses.",
      inputSchema: { year: z.number().int(), property: scope },
      annotations: ro,
    },
    wrap(({ year, property }) => reports.categoryMonths(db, year, ledger.resolvePropertyScope(db, property))),
  );

  server.registerTool(
    "get_recurring",
    {
      description:
        "Recurring bills/income learned from history (cadence, typical amount, next due date, status) and alerts: missing payments, possible duplicates, amount changes. Use this to answer 'am I missing anything?'.",
      inputSchema: { property: scope, include_history: z.boolean().default(false) },
      annotations: ro,
    },
    wrap(({ property, include_history }) => {
      const r = recurring.recurring(db, {
        propertyId: ledger.resolvePropertyScope(db, property),
      });
      return include_history ? r : { ...r, series: r.series.map(({ history: _h, expected_months: _e, ...s }) => s) };
    }),
  );

  server.registerTool(
    "get_todo",
    {
      description:
        "The user's to-do list: counts of flagged entries, expenses with no direct/indirect set, recurring-bill alerts (missing, duplicate, changed), expenses in receipts_year (last year until the end of April) that should have a receipt and don't (per category receipt rules and never-ask names; list them with search_transactions needs_receipt=true), plus the recurring alerts themselves, and occupancy_items: likely owner stays to confirm (add_owner_stay or dismiss_owner_stay_candidate, after asking the user) and ended months where the booking calendar's guest nights differ from the saved occupancy (apply_calendar_to_occupancy, or keep_occupancy_numbers when the user says the saved numbers are right). Use search_transactions (needs_review=true, allocation=none) for the entries.",
      inputSchema: { property: scope },
      annotations: ro,
    },
    wrap(({ property }) => todoSummary(db, { propertyId: ledger.resolvePropertyScope(db, property) })),
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
        "Rename a category or change its default tax treatment / Schedule E line / archived flag / receipt rule. Ask the user first.",
      inputSchema: {
        category: ref.describe("Category name or id"),
        name: z.string().optional(),
        default_allocation: z.enum(["direct", "indirect"]).nullable().optional(),
        schedule_e_line: z.string().nullable().optional(),
        description: z.string().optional(),
        archived: z.boolean().optional(),
        ...receiptFields,
      },
    },
    wrap(({ category, ...patch }) => ledger.updateCategory(db, actor, ledger.resolveCategory(db, category).id, patch)),
  );

  server.registerTool(
    "list_receipt_exclusions",
    {
      description:
        "Vendors that never need a receipt in any category (e.g. Airbnb, Stripe), with how many expenses each matches. Subcategories have their own rules (set_subcategory_receipt_rule).",
      inputSchema: {},
      annotations: ro,
    },
    wrap(() => receipts.listReceiptExclusions(db)),
  );

  server.registerTool(
    "add_receipt_exclusion",
    {
      description:
        "Stop asking for receipts from a vendor (matched case-insensitively against the vendor field, in any category). For a subcategory use set_subcategory_receipt_rule. Ask the user first.",
      inputSchema: { name: z.string(), note: z.string().optional() },
    },
    wrap((args) => receipts.addReceiptExclusion(db, actor, args)),
  );

  server.registerTool(
    "remove_receipt_exclusion",
    {
      description: "Ask for receipts from a vendor on the never-ask list again. Ask the user first.",
      inputSchema: { name: ref.describe("Name or id") },
    },
    wrap(({ name }) => receipts.removeReceiptExclusion(db, actor, name)),
  );

  server.registerTool(
    "set_subcategory_receipt_rule",
    {
      description:
        "Give a subcategory its own receipt rule (always / threshold with receipt_min / never), or receipt_policy=inherit to use the category's again. Rules show in list_categories. Ask the user first.",
      inputSchema: {
        category: ref.describe("Category name or id"),
        name: z.string().describe("Subcategory name"),
        receipt_policy: z.enum(["always", "threshold", "never", "inherit"]),
        receipt_min: z.number().positive().nullable().optional().describe("Dollars, for threshold; null = category's"),
      },
    },
    wrap((args) => cats.setSubcategoryReceiptRule(db, actor, args)),
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
    "preview_manager_month",
    {
      description:
        "Reconcile the property manager's monthly paperwork against the ledger WITHOUT writing. Pass just `month` to review that month's saved documents (see list_manager_months), or pass the owner-statement CSV text and/or the invoice text (all pages; read the PDF yourself) or parsed invoice lines. Shows which reservation payouts are recorded (Airbnb: one deposit; VRBO: deposit + balance, or batched in Stripe transfers), which invoice lines are missing, and cross-checks (management fee, cleaning, waiver, commission, totals). Run this before apply_manager_month.",
      inputSchema: {
        statement_csv: z.string().optional().describe("Owner statement CSV text"),
        invoice_text: z.string().optional().describe("Invoice text, all pages"),
        invoice: z
          .object({
            number: z.string().optional(),
            total: z.number().optional(),
            lines: z.array(
              z.object({
                item: z.string(),
                description: z.string().optional(),
                quantity: z.number().optional(),
                amount: z.number().describe("Positive dollars billed for the line"),
              }),
            ),
          })
          .optional()
          .describe("Alternative to invoice_text: lines you extracted yourself"),
        month: z
          .string()
          .optional()
          .describe("Service month YYYY-MM. Alone: use the saved documents. Default: statement check-out month"),
        subcategory: z.string().optional().describe("Manager name used as subcategory (default: from history)"),
        property: one,
      },
      annotations: ro,
    },
    wrap((args) => {
      const { statement, ...r } = manager.previewManagerMonth(db, args);
      void statement;
      return r;
    }),
  );

  server.registerTool(
    "apply_manager_month",
    {
      description:
        "Write what preview_manager_month proposed. Takes the same inputs plus which missing income rows (create_income: reservation ids) and invoice lines (create_lines: line keys from the preview) to create; overrides sets a category for a line the preview couldn't categorize. Matched income rows get the reservation id noted in an empty description; a deposit that differs from the statement is flagged for review (once). Already-recorded items are never duplicated. With only `month`, the saved documents are used and attached to the entries. Ask the user before creating income rows.",
      inputSchema: {
        statement_csv: z.string().optional(),
        invoice_text: z.string().optional(),
        invoice: z
          .object({
            number: z.string().optional(),
            total: z.number().optional(),
            lines: z.array(
              z.object({
                item: z.string(),
                description: z.string().optional(),
                quantity: z.number().optional(),
                amount: z.number(),
              }),
            ),
          })
          .optional(),
        month: z.string().optional(),
        subcategory: z.string().optional(),
        property: one,
        tag_income: z.boolean().optional(),
        create_income: z.array(z.string()).optional(),
        create_lines: z.array(z.union([z.string(), z.number().int()])).optional(),
        overrides: z
          .record(z.string(), z.object({ category: ref.optional(), description: z.string().optional() }))
          .optional()
          .describe("Keyed by invoice line key"),
      },
    },
    wrap((args) =>
      args.statement_csv == null && args.invoice_text == null && args.invoice == null
        ? docs.applySavedMonth(db, actor, args)
        : manager.applyManagerMonth(db, actor, args),
    ),
  );

  server.registerTool(
    "explain_manager_check",
    {
      description:
        "Mark a warning from a manager-month review as explained (e.g. the manager confirmed a refund), so it no longer counts as a to-do; the note shows on the month. Pass the check's key from preview_manager_month. undo=true reopens it. Ask the user first.",
      inputSchema: {
        month: z.string(),
        key: z.string(),
        note: z.string().optional(),
        undo: z.boolean().optional(),
        property: one,
      },
    },
    wrap(({ undo, ...args }) =>
      undo ? manager.unacknowledgeCheck(db, actor, args) : manager.acknowledgeCheck(db, actor, args),
    ),
  );

  server.registerTool(
    "list_manager_months",
    {
      description:
        "The manager paperwork saved for a year: per month, the saved owner statement and invoices and a status (done, todo = entries to add, check = something to look at, empty = nothing saved).",
      inputSchema: { year: z.number().int(), property: one },
      annotations: ro,
    },
    wrap(({ year, property }) => manager.managerYear(db, { year, property })),
  );

  server.registerTool(
    "save_manager_document",
    {
      description:
        "Save an owner-statement CSV or a manager invoice so its month can be reviewed later. Give the text (CSV, or the invoice's text) or the original file as base64 (a PDF is read automatically). The kind and month are detected; pass month to override. A different file for a month's statement (or the same invoice number) is reported as a conflict unless replace=true.",
      inputSchema: {
        filename: z.string(),
        text: z.string().optional(),
        base64: z.string().optional(),
        month: z.string().optional(),
        replace: z.boolean().optional(),
        property: one,
      },
    },
    wrap(async ({ filename, text, base64, month, replace, property }) => {
      if (!text && !base64) throw new Error("Give text or base64");
      const data = base64 ? new Uint8Array(Buffer.from(base64, "base64")) : new TextEncoder().encode(text!);
      const contentType = /\.pdf$/i.test(filename)
        ? "application/pdf"
        : /\.csv$/i.test(filename)
          ? "text/csv"
          : "text/plain";
      return docs.saveDocuments(db, actor, [{ filename, contentType, data }], { month, replace, property });
    }),
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

  server.registerTool(
    "inspect_csv",
    {
      description:
        "Look at a CSV export (any bank, card or provider) before importing: delimiter, header row, a sample of each column, and a suggested column mapping (a saved import profile with the same headers when there is one). Pass the mapping, adjusted if needed, to preview_csv_import.",
      inputSchema: {
        text: z.string().describe("The CSV file's text"),
        profile_id: z.number().int().optional().describe("Use this saved profile instead of auto-detecting"),
      },
    },
    wrap((args) => {
      const r = csvImport.inspectCsv(db, args);
      const { rows: _rows, ...rest } = r;
      return { ...rest, columns: r.columns.map((c) => ({ ...c, samples: c.samples.slice(0, 3) })) };
    }),
  );

  server.registerTool(
    "preview_csv_import",
    {
      description:
        "Apply a column mapping to a CSV and check each row against the ledger WITHOUT writing. Statuses: new, duplicate (same transaction id, or same day + amount), possible (same amount within window_days: ask the user), error, skipped (matched one of mapping.skip_rules [{column, contains}], e.g. money-market sweeps). Each row has a guessed `category` (from the file or vendor history; null = ask). To add rows, pass them to bulk_add_transactions as {date, amount, category, subcategory, vendor, reference, description, account, external_id, property, refund: true} with skip_duplicates=false (the preview already decided).",
      inputSchema: {
        text: z.string().describe("The CSV file's text"),
        mapping: z.record(z.string(), z.unknown()).describe("The mapping from inspect_csv (or a saved profile)"),
        property: one,
        window_days: z.number().int().min(0).max(14).optional(),
        only_attention: z
          .boolean()
          .default(false)
          .describe("Leave out plain new rows that already have a category (to keep a long file short)"),
      },
    },
    wrap(({ only_attention, ...args }) => {
      const r = csvImport.previewImport(db, args);
      return {
        summary: r.summary,
        rows: (only_attention
          ? r.rows.filter((x) => x.status !== "new" || x.category_id == null || x.warnings.length)
          : r.rows
        ).map(({ category_id: _c, cells: _cells, property_id, external_id, ...x }) => ({
          ...x,
          property: property_id,
          external_id: external_id ?? undefined,
        })),
      };
    }),
  );

  server.registerTool(
    "list_import_profiles",
    { description: "Saved CSV column mappings, one per bank/provider export layout.", inputSchema: {} },
    wrap(() => csvImport.listProfiles(db)),
  );

  server.registerTool(
    "save_import_profile",
    {
      description:
        "Save a CSV column mapping under a name (replaces a profile with the same name). `headers` is the file's header row, used to pick the profile automatically next time.",
      inputSchema: {
        name: z.string(),
        headers: z.array(z.string()),
        mapping: z.record(z.string(), z.unknown()),
      },
    },
    wrap((args) => csvImport.saveProfile(db, actor, args)),
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
