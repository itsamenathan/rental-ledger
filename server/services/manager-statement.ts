/**
 * Monthly property-manager paperwork: an owner-statement CSV (one row per reservation, with the payout the manager
 * collected for you) and a PDF/text invoice (what you owe the manager for management, cleaning, repairs...).
 *
 * Both are reconciled against the ledger rather than imported blindly: income that is already recorded is matched
 * to its reservation, expense lines that are already recorded are skipped, and only what is missing is created.
 * preview* never writes; apply* re-runs the same analysis inside a transaction so a stale preview cannot duplicate rows.
 */
import { and, desc, eq, gte, isNull, lte, like, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { auditLog, categories, managerAcknowledgements, managerDocuments, transactions } from "../db/schema.ts";
import { propertyScope } from "../portfolio.ts";
import { audit, badRequest, cents, requireWrite, type Actor } from "../context.ts";
import { parseCsv } from "./csv.ts";
import { createTransaction, listCategories, resolvePropertyId, updateTransaction, type Category } from "./ledger.ts";

// ======================= small helpers =======================

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const dayNumber = (iso: string) => Math.round(Date.parse(iso + "T00:00:00Z") / 86_400_000);
const addDays = (iso: string, n: number) => new Date((dayNumber(iso) + n) * 86_400_000).toISOString().slice(0, 10);
const lastDayOfMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const prevMonth = (iso: string) => {
  const [y, m] = iso.slice(0, 7).split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

/** "$1,234.56", "(12.00)", "-$5" → integer cents. Anything else → null. */
export function moneyToCents(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  s = s.replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const c = Math.round(Number(s) * 100);
  return neg ? -c : c;
}

export function toIsoDate(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return null;
}

const usd = (c: number) =>
  `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const isAirbnb = (r: { channel: string }) => /airbnb/i.test(r.channel);
const channelLabel = (rs: { channel: string }[]) =>
  [
    ...new Set(
      rs.map((r) =>
        /vrbo|homeaway/i.test(r.channel)
          ? "VRBO"
          : /booking ?engine|direct/i.test(r.channel)
            ? "direct-booking"
            : r.channel || "other",
      ),
    ),
  ].join("/");
const shortDate = (iso: string) =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]!.slice(0, 1).toUpperCase()}${MONTHS[Number(iso.slice(5, 7)) - 1]!.slice(1, 3)} ${Number(iso.slice(8, 10))}`;

// ======================= statement CSV =======================

export const reservationSchema = z.object({
  reservation_id: z.string().min(1).max(100),
  channel: z.string().max(100).default(""),
  guest: z.string().max(200).default(""),
  check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z.number().int().min(0).default(0),
  /** What the manager collected for you (after the booking channel's fee), before their own charges. */
  payout: z.number(),
  /** Cleaning fee the guest paid (the manager may bill you a different amount). */
  cleaning_fee: z.number().default(0),
  management_fee: z.number().default(0),
  channel_fee: z.number().default(0),
  /** VRBO / direct-booking extras. The manager bills the waiver and VRBO commission back on the invoice. */
  insurance_waiver: z.number().default(0),
  commission: z.number().default(0),
  /** Lodging tax collected from the guest (included in the payout). */
  taxes: z.number().default(0),
  processing_fee: z.number().default(0),
  /** Booking date. VRBO pays part of the payout around then. */
  booked: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  /** Not a stay: 0 nights, or a cancellation payout with no rent. Payouts still reconcile; the calendar skips it. */
  cancelled: z.boolean().default(false),
});
export type Reservation = z.infer<typeof reservationSchema>;

const TOTAL_KEYS = [
  "payout",
  "cleaning_fee",
  "management_fee",
  "channel_fee",
  "insurance_waiver",
  "commission",
  "taxes",
] as const;
export type StatementTotals = Record<(typeof TOTAL_KEYS)[number], number>;

function totalsOf(rs: Reservation[]): StatementTotals {
  const out = {} as StatementTotals;
  for (const k of TOTAL_KEYS) out[k] = rs.reduce((sum, r) => sum + cents(r[k]), 0) / 100;
  return out;
}

export interface ParsedStatement {
  reservations: Reservation[];
  totals: StatementTotals;
  warnings: string[];
}

/** Columns are matched by suffix so the manager's name prefix (e.g. "XxxOwnerPayout") is never hard-coded. */
export function parseStatementCsv(text: string): ParsedStatement {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  const col = {
    id: find(/^reservation id$/i),
    checkIn: find(/^check-?in( date)?$/i),
    checkOut: find(/^check-?out( date)?$/i),
    payout: find(/ownerpayout$/i),
    channel: find(/^channel$/i),
    guest: find(/^guest$/i),
    nights: find(/^nights$/i),
    cleaning: find(/cleaningfee$/i),
    management: find(/managementfee$/i),
    rent: find(/rent$/i),
    channelFee: find(/^host channel fee$/i),
    resort: find(/^resort fee/i),
    waiver: find(/insurancewaiver$/i),
    commission: find(/commission$/i),
    taxes: find(/taxes$/i),
    processing: find(/processing fees?$/i),
    booked: find(/^reservation date$/i),
  };
  // read only to tell the calendar a row wasn't a stay; still unmodeled, so a nonzero amount is still a warning
  const cancellationCol = find(/^cancell?ation payout$/i);
  const missing = (
    [
      ["Reservation ID", col.id],
      ["Check-in date", col.checkIn],
      ["Check-out date", col.checkOut],
      ["...OwnerPayout", col.payout],
    ] as const
  )
    .filter(([, i]) => i < 0)
    .map(([n]) => n);
  if (missing.length)
    throw badRequest(`This doesn't look like an owner statement CSV: missing column(s) ${missing.join(", ")}`);

  const modeled = new Set(Object.values(col).filter((i) => i >= 0));
  const warnings: string[] = [];
  const reservations: Reservation[] = [];
  let totalsPayout: number | null = null;
  const num = (r: string[], i: number) => (i >= 0 ? (moneyToCents(r[i]) ?? 0) / 100 : 0);

  for (const r of rows.slice(1)) {
    const first = (r[0] ?? "").trim();
    if (/^totals?$/i.test(first)) {
      totalsPayout ??= moneyToCents(r[col.payout]);
      continue;
    }
    const id = (r[col.id] ?? "").trim();
    const checkIn = toIsoDate(r[col.checkIn]);
    const checkOut = toIsoDate(r[col.checkOut]);
    if (!id || !checkIn || !checkOut) continue; // spacer / portfolio total rows
    const payout = moneyToCents(r[col.payout]);
    if (payout == null) {
      warnings.push(`Reservation ${id}: payout "${r[col.payout]}" isn't an amount; skipped`);
      continue;
    }
    // Anything money-like in a column we don't model (pet fees, discounts, cancellations...) needs a human look.
    const extra: string[] = [];
    header.forEach((h, i) => {
      if (modeled.has(i) || !/^\(?-?\$/.test((r[i] ?? "").trim())) return;
      const c = moneyToCents(r[i]);
      if (c) extra.push(`"${h}" ${usd(c)}`);
    });
    if (extra.length) warnings.push(`Reservation ${id}: amounts in columns that aren't modeled: ${extra.join(", ")}`);
    reservations.push({
      reservation_id: id,
      channel: (r[col.channel] ?? "").trim(),
      guest: (r[col.guest] ?? "").trim(),
      check_in: checkIn,
      check_out: checkOut,
      nights: col.nights >= 0 ? Number(r[col.nights] ?? 0) || 0 : Math.max(0, dayNumber(checkOut) - dayNumber(checkIn)),
      payout: payout / 100,
      cleaning_fee: num(r, col.cleaning),
      management_fee: num(r, col.management),
      channel_fee: num(r, col.channelFee),
      insurance_waiver: num(r, col.waiver),
      commission: num(r, col.commission),
      taxes: num(r, col.taxes),
      processing_fee: num(r, col.processing),
      booked: col.booked >= 0 ? toIsoDate(r[col.booked]) : null,
      cancelled:
        (col.nights >= 0 && (r[col.nights] ?? "").trim() !== "" && Number(r[col.nights]) === 0) ||
        (num(r, cancellationCol) !== 0 && (col.rent < 0 || num(r, col.rent) === 0)),
    });
  }
  if (!reservations.length) throw badRequest("No reservations found in the statement CSV");

  const totals = totalsOf(reservations);
  if (totalsPayout != null && totalsPayout !== cents(totals.payout))
    warnings.push(
      `The statement's TOTALS row (${usd(totalsPayout)}) doesn't equal the sum of its reservations (${usd(cents(totals.payout))})`,
    );
  const ids = new Set<string>();
  for (const r of reservations) {
    if (ids.has(r.reservation_id)) warnings.push(`Reservation ${r.reservation_id} appears more than once`);
    ids.add(r.reservation_id);
  }
  return { reservations, totals, warnings };
}

// ======================= invoice text =======================

export const invoiceLineSchema = z.object({
  item: z.string().trim().min(1).max(300),
  description: z.string().max(2000).default(""),
  quantity: z.number().default(1),
  unit_price: z.number().optional(),
  amount: z.number(),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

export const invoiceSchema = z.object({
  number: z.string().max(100).default(""),
  issued: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  paid: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  total: z.number().nullable().default(null),
  lines: z.array(invoiceLineSchema).min(1).max(200),
});
export type Invoice = z.infer<typeof invoiceSchema> & { warnings?: string[] };

function longDate(raw: string | undefined): string | null {
  const m = raw?.match(/([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})/);
  const mi = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1;
  return m && mi >= 0 ? `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : null;
}

/**
 * Parses the text of an invoice laid out as "Item  Qty  $Price  $Total" rows, each optionally followed by detail lines.
 * Pass the text of all pages joined: items can span a page break.
 */
export function parseInvoiceText(text: string): Invoice {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const warnings: string[] = [];
  const itemRe = /^(.+?) (\d+(?:\.\d+)?) \$([\d,]+\.\d{2}) \$([\d,]+\.\d{2})$/;
  const items: { item: string; quantity: number; unit: number; total: number; details: string[] }[] = [];
  let current: (typeof items)[number] | null = null;

  for (const line of lines) {
    if (/^Subtotal\b/i.test(line)) break;
    // Browser print header/footer ("11/15/26, 8:58 AM Invoice #2061 - ...") and "<Name>: $total" page banners.
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4},/.test(line) || /^[^$]{1,80}:\s*\$[\d,]+\.\d{2}$/.test(line)) continue;
    if (/^ITEM\b.*\bTOTAL$/i.test(line)) continue;
    const m = line.match(itemRe);
    if (m) {
      current = {
        item: m[1]!,
        quantity: Number(m[2]),
        unit: moneyToCents(m[3])! / 100,
        total: moneyToCents(m[4])! / 100,
        details: [],
      };
      items.push(current);
    } else if (current) current.details.push(line);
  }
  if (!items.length)
    throw badRequest("Couldn't find any invoice line items (expected rows like 'Cleaning 1 $165.00 $165.00')");

  const parsedLines: InvoiceLine[] = items.map((i) => {
    if (Math.abs(i.quantity * i.unit - i.total) > 0.005)
      warnings.push(`"${i.item}": ${i.quantity} × ${usd(cents(i.unit))} isn't ${usd(cents(i.total))}`);
    // A trailing "... $168.51" on a detail line is the manager restating the line total; drop that summary line.
    const details = i.details.filter((d) => {
      const t = d.match(/\$([\d,]+\.\d{2})$/);
      return !(t && moneyToCents(t[1]) === cents(i.total));
    });
    return {
      item: i.item,
      description: details.join("; ").slice(0, 2000),
      quantity: i.quantity,
      unit_price: i.unit,
      amount: i.total,
    };
  });

  const joined = lines.join("\n");
  const totalM = joined.match(/(?<![A-Za-z])Total:\s*\$([\d,]+\.\d{2})/);
  const total = totalM ? moneyToCents(totalM[1])! / 100 : null;
  const sum = parsedLines.reduce((s, l) => s + cents(l.amount), 0);
  if (total == null) warnings.push("No invoice Total found; line items could not be verified");
  else if (cents(total) !== sum)
    warnings.push(`Line items add up to ${usd(sum)} but the invoice total is ${usd(cents(total))}`);

  return {
    number: joined.match(/\bInvoice\s+#?\s*(\d+)/i)?.[1] ?? "",
    issued: longDate(joined.match(/Issued\s+([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})/)?.[1]),
    // Capital-P "Payment received" is the settled payment; "Pending payment received" is the earlier authorization.
    paid: longDate(joined.match(/Payment received\s+([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})/)?.[1]),
    total,
    lines: parsedLines,
    warnings,
  };
}

// ======================= saved documents (read side) =======================

export interface SavedDoc {
  id: number;
  month: string;
  kind: "statement" | "invoice";
  filename: string;
  content_type: string;
  size: number;
  reference: string;
  created_at: string;
}

const docCols = {
  id: managerDocuments.id,
  month: managerDocuments.month,
  kind: managerDocuments.kind,
  filename: managerDocuments.filename,
  content_type: managerDocuments.contentType,
  size: managerDocuments.size,
  reference: managerDocuments.reference,
  created_at: managerDocuments.createdAt,
};

export function listDocuments(db: DB, propertyId: number, opts: { month?: string; year?: number } = {}): SavedDoc[] {
  return db
    .select(docCols)
    .from(managerDocuments)
    .where(
      and(
        propertyScope(db, managerDocuments.propertyId, propertyId),
        opts.month ? eq(managerDocuments.month, opts.month) : undefined,
        opts.year ? like(managerDocuments.month, `${opts.year}-%`) : undefined,
      ),
    )
    .orderBy(managerDocuments.month, managerDocuments.kind, managerDocuments.id)
    .all();
}

function docTexts(db: DB, propertyId: number) {
  return db
    .select({
      id: managerDocuments.id,
      month: managerDocuments.month,
      kind: managerDocuments.kind,
      text: managerDocuments.text,
    })
    .from(managerDocuments)
    .where(propertyScope(db, managerDocuments.propertyId, propertyId))
    .orderBy(managerDocuments.month, managerDocuments.id)
    .all();
}

/** Parse every saved statement once (bad ones are skipped: they show their error when their month is opened). */
export function savedStatements(db: DB, propertyId: number) {
  const out: { docId: number; month: string; statement: ParsedStatement }[] = [];
  for (const d of docTexts(db, propertyId)) {
    if (d.kind !== "statement") continue;
    try {
      out.push({ docId: d.id, month: d.month, statement: parseStatementCsv(d.text) });
    } catch {
      // ignored here
    }
  }
  return out;
}

// ======================= analysis =======================

const ref = z.union([z.number().int(), z.string()]);
const baseInput = z.object({
  property: ref.optional().describe("Property id or name; defaults to the only property"),
  property_id: z.number().int().optional(),
  month: z
    .string()
    .regex(MONTH, "Use YYYY-MM")
    .optional()
    .describe(
      "Service month. With no statement/invoice given, the month's saved documents are used. Default: the statement's check-out month",
    ),
  subcategory: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe("Manager name used as the subcategory on their charges. Default: from past Management Fee rows"),
  statement_csv: z.string().max(5_000_000).optional().describe("Owner-statement CSV text"),
  statement: z.object({ reservations: z.array(reservationSchema).min(1).max(2000) }).optional(),
  invoice_text: z.string().max(1_000_000).optional().describe("Invoice text (all pages), parsed for line items"),
  invoice: invoiceSchema.optional(),
});
const needsSomething = (v: {
  statement_csv?: string;
  statement?: unknown;
  invoice_text?: string;
  invoice?: unknown;
  month?: string;
}) => v.statement_csv != null || v.statement != null || v.invoice_text != null || v.invoice != null || v.month != null;
const needsMsg = { message: "Provide a month (to use its saved documents), a statement (CSV) and/or an invoice" };

export const previewInput = baseInput.refine(needsSomething, needsMsg);

export const applyInput = baseInput
  .extend({
    tag_income: z
      .boolean()
      .default(true)
      .describe("Note the reservation id in matched income rows' (empty) description"),
    create_income: z
      .array(z.string())
      .default([])
      .describe("Reservation ids whose missing income rows should be created"),
    create_lines: z
      .array(z.union([z.number().int().min(0), z.string()]))
      .default([])
      .describe("Invoice lines to create as expenses: their `key` from the preview (or index)"),
    overrides: z
      .record(
        z.string(),
        z.object({
          category: ref.optional(),
          description: z.string().max(2000).optional(),
        }),
      )
      .default({})
      .describe("Per invoice line (its key or index, as a string): category / description to use when creating it"),
  })
  .refine(needsSomething, needsMsg);

type PreviewInput = z.infer<typeof previewInput>;

/** "$200.00 less" / "$50.00 more": the deposit against the statement. */
function differenceAmount(i: IncomeRowView) {
  const d = cents(i.difference!);
  return `${usd(Math.abs(d))} ${d < 0 ? "less" : "more"}`;
}

/** The management fee's share of a shortfall, at the stay's own fee rate: what a fee on the full amount overcharged. */
function feeOnShortfall(i: IncomeRowView) {
  const payout = cents(i.payout);
  const fee = Math.abs(cents(i.management_fee));
  const d = cents(i.difference!);
  return d < 0 && fee && payout > 0 ? Math.round((fee * -d) / payout) : 0;
}

/** The wording before the difference and fee were spelled out. Its hash stays the warning's key, so warnings marked as
 * explained stay explained; the amounts and dates are in it, so a changed payout or deposit still asks again. */
function legacyDifferenceText(i: IncomeRowView) {
  return `The ${shortDate(i.check_in)} stay (#${i.reservation_id}) is ${usd(cents(i.payout))} on the statement but ${usd(cents(i.payout) + cents(i.difference!))} was deposited (${shortDate(i.transaction_date!)}). Ask your manager about the difference (a refund, resolution or adjustment); the management fee may have been charged on the full amount`;
}

function differenceText(i: IncomeRowView) {
  const fee = feeOnShortfall(i);
  const shortfall = cents(i.difference!) < 0;
  return (
    `The ${shortDate(i.check_in)} stay (#${i.reservation_id}) is ${usd(cents(i.payout))} on the statement but ${usd(cents(i.payout) + cents(i.difference!))} was deposited (${shortDate(i.transaction_date!)}), ${differenceAmount(i)}. ` +
    `Ask your manager about the ${usd(Math.abs(cents(i.difference!)))} (a refund, resolution or adjustment)` +
    (fee
      ? `; the management fee (${usd(Math.abs(cents(i.management_fee)))}) may have been charged on the full amount, about ${usd(fee)} of it on the missing ${usd(-cents(i.difference!))}`
      : shortfall
        ? "; the management fee may have been charged on the full amount"
        : "")
  );
}

interface LedgerRow {
  id: number;
  date: string;
  amountCents: number;
  categoryId: number;
  subcategory: string;
  description: string;
}

export interface IncomeRowView extends Reservation {
  /** matched: the payout is in the ledger (one deposit, or a VRBO deposit + balance). differs: a deposit around the
   * stay is close but not equal. missing: nothing found (Airbnb). batched: a VRBO / direct-booking payout not tied to
   * a deposit; those are paid through Stripe, which can combine several bookings into one transfer. */
  status: "matched" | "differs" | "missing" | "batched";
  transaction_id?: number;
  transaction_date?: string;
  transactions?: { id: number; date: string; amount: number }[];
  /** Ledger amount minus statement payout, for "differs". */
  difference?: number;
  /** The reservation id is already noted on the ledger row(s). */
  tagged?: boolean;
  suggested_date?: string;
}

export interface LineView extends InvoiceLine {
  /** Stable id for create_lines / overrides: "<invoice number or document>#<line>". */
  key: string;
  index: number;
  invoice: string;
  document_id: number | null;
  category: string | null;
  category_id: number | null;
  status: "exists" | "missing" | "uncategorized";
  transaction_id?: number;
  /** Category of the existing row when it differs from the suggestion. */
  ledger_category?: string;
  /** Date the new row will get. */
  date: string;
}

export interface Check {
  level: "ok" | "warn" | "info";
  text: string;
  /** Warnings only: identifies the check for "mark as explained" (changes if the amounts change). */
  key?: string;
  /** A warning someone marked as explained: shown as a note, no longer counted. */
  explained?: { note: string; at: string };
  /** "income" / "lines" for the payout and invoice-line coverage checks (the page's headline already says this). */
  code?: "income" | "lines";
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Item → category when history has nothing to say. Matches on well-known words only; each rule tries the default
 * categories' names (server/seed.ts) first, then older names a portfolio may still use.
 */
const CATEGORY_RULES: [RegExp, string[]][] = [
  [/manage/, ["Management fees", "Management Fee"]],
  [/clean|hot ?tub|laundry|linen/, ["Cleaning and maintenance", "Cleaning"]],
  [/minut|noise|software|subscription|monitor/, ["Services", "Miscellaneous"]],
  [/propane|supplies|restock|consumable|toiletr/, ["Supplies"]],
  [/plumb|electric/, ["Plumbing and electrical", "Repairs", "Maintenance"]],
  [/repair|maint|handyman|dump|install|plow/, ["Repairs", "Maintenance"]],
  [/furnish|mattress|appliance/, ["Furnishings", "Supplies"]],
  [/commission|insurance waiver/, ["VRBO Fees", "Commissions"]],
];

interface InvoiceInput extends Invoice {
  documentId: number | null;
}

interface Analysis {
  propertyId: number;
  month: string;
  subcategory: string;
  statement: ParsedStatement | null;
  invoices: InvoiceInput[];
  documents: SavedDoc[];
  income: IncomeRowView[];
  unlisted: { id: number; date: string; amount: number }[];
  lines: LineView[];
  checks: Check[];
  warnings: string[];
  incomeCategory: Category | null;
}

function defaultManagerSubcategory(db: DB, propertyId: number): string {
  const row = db
    .select({ sub: transactions.subcategory })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.propertyId, propertyId),
        like(sql`lower(${categories.name})`, "management%"),
        sql`${transactions.subcategory} <> ''`,
      ),
    )
    .orderBy(desc(transactions.date), desc(transactions.id))
    .get();
  return row?.sub ?? "";
}

function ledgerRows(db: DB, propertyId: number, kind: "income" | "expense", from: string, to: string): LedgerRow[] {
  return db
    .select({
      id: transactions.id,
      date: transactions.date,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      subcategory: transactions.subcategory,
      description: transactions.description,
    })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.propertyId, propertyId),
        eq(categories.kind, kind),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .orderBy(transactions.date, transactions.id)
    .all();
}

function suggestCategory(
  item: string,
  history: { description: string; category: string }[],
  byName: Map<string, Category>,
): Category | null {
  const n = norm(item);
  // An earlier row described exactly like this item wins outright.
  const exact = history.find((h) => norm(h.description) === n);
  if (exact && byName.get(exact.category.toLowerCase())) return byName.get(exact.category.toLowerCase())!;
  // Then history: a past row of this manager whose description is (part of) this item, or the reverse.
  const votes = new Map<string, number>();
  for (const h of history) {
    const d = norm(h.description);
    if (d.length >= 4 && n.length >= 4 && (n.includes(d) || d.includes(n)))
      votes.set(h.category, (votes.get(h.category) ?? 0) + 1);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best && byName.get(best.toLowerCase())) return byName.get(best.toLowerCase())!;
  for (const [re, names] of CATEGORY_RULES) {
    if (!re.test(n)) continue;
    for (const name of names) if (byName.get(name.toLowerCase())) return byName.get(name.toLowerCase())!;
  }
  return null;
}

/** The month a statement covers: the most common check-out month. */
export function statementMonth(statement: ParsedStatement): string {
  const counts = new Map<string, number>();
  for (const r of statement.reservations)
    counts.set(r.check_out.slice(0, 7), (counts.get(r.check_out.slice(0, 7)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0]![0];
}

/**
 * The month an invoice covers. Best evidence first: its Management line equals a statement's management-fee total
 * (true for every 2026 month); then a month named in an item ("September Cleaning"); then the issue date (invoices go
 * out early the next month, so one issued after the 15th covers its own month).
 */
export function invoiceMonth(invoice: Invoice, statements: { month: string; statement: ParsedStatement }[] = []) {
  const mgmt = invoice.lines.filter((l) => /^manage/.test(norm(l.item))).reduce((sum, l) => sum + cents(l.amount), 0);
  if (mgmt) {
    const hits = statements.filter((s) => cents(s.statement.totals.management_fee) === mgmt);
    if (hits.length === 1) return hits[0]!.month;
  }
  const year = invoice.issued?.slice(0, 4);
  for (const l of invoice.lines) {
    const named = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(l.item.toLowerCase()));
    if (named >= 0 && year) {
      const month = `${year}-${String(named + 1).padStart(2, "0")}`;
      // "December Cleaning" on an invoice issued in January belongs to the previous year.
      return invoice.issued && month > invoice.issued.slice(0, 7) ? `${Number(year) - 1}${month.slice(4)}` : month;
    }
  }
  if (invoice.issued)
    return Number(invoice.issued.slice(8, 10)) > 15 ? invoice.issued.slice(0, 7) : prevMonth(invoice.issued);
  return null;
}

// ---------- payout matching across every known statement ----------

interface Claims {
  matched: Map<string, LedgerRow[]>;
  /** Reservations whose tagged rows don't add up to the payout. */
  taggedDiffers: Map<string, LedgerRow[]>;
  used: Set<number>;
  pool: LedgerRow[];
}

const otherTag = (p: LedgerRow) => /Reservation \S+/.test(p.description);
// VRBO pays roughly 30% around booking and the rest before check-in, so look back to the booking date.
// Without a booking date, look back a year: a ~30% part plus an exact balance is a strong enough signal.
const earliest = (r: Reservation) =>
  r.booked && r.booked < r.check_in ? addDays(r.booked, -30) : addDays(r.check_in, -365);
const nearStay = (p: LedgerRow, r: Reservation) =>
  p.date >= addDays(r.check_in, -3) && p.date <= addDays(r.check_out, 10);
const byCloseness = (r: Reservation) => {
  const target = dayNumber(addDays(r.check_in, 2));
  return (a: LedgerRow, b: LedgerRow) => Math.abs(dayNumber(a.date) - target) - Math.abs(dayNumber(b.date) - target);
};

/**
 * Exact matches (tagged rows, one exact deposit, a ~30% deposit + balance) for every reservation on every known
 * statement, in check-in order, so a deposit is claimed by the stay it really belongs to whichever month is viewed.
 */
function claimDeposits(db: DB, propertyId: number, reservations: Reservation[]): Claims {
  const rs = [...reservations].sort((a, b) => a.check_in.localeCompare(b.check_in));
  const empty = { matched: new Map(), taggedDiffers: new Map(), used: new Set<number>(), pool: [] };
  if (!rs.length) return empty;
  const lo = rs.reduce((m, r) => (earliest(r) < m ? earliest(r) : m), addDays(rs[0]!.check_in, -3));
  const hi = addDays(
    rs.reduce((m, r) => (r.check_out > m ? r.check_out : m), rs[0]!.check_out),
    10,
  );
  const pool = ledgerRows(db, propertyId, "income", lo, hi);
  const used = new Set<number>();
  const matched = new Map<string, LedgerRow[]>();
  const taggedDiffers = new Map<string, LedgerRow[]>();
  const take = (r: Reservation, rows: LedgerRow[]) => {
    for (const p of rows) used.add(p.id);
    matched.set(r.reservation_id, rows);
  };
  const free = (p: LedgerRow, r: Reservation) =>
    !used.has(p.id) && (p.description.includes(r.reservation_id) || !otherTag(p));
  const open = (r: Reservation) => !matched.has(r.reservation_id) && !taggedDiffers.has(r.reservation_id);

  // Pass 1: rows already tagged with this reservation. A tag isn't proof the amount is right, so they must add up.
  for (const r of rs) {
    const tagged = pool.filter((p) => !used.has(p.id) && p.description.includes(r.reservation_id));
    if (!tagged.length) continue;
    if (tagged.reduce((sum, p) => sum + p.amountCents, 0) === cents(r.payout)) take(r, tagged);
    else {
      for (const p of tagged) used.add(p.id);
      taggedDiffers.set(r.reservation_id, tagged);
    }
  }
  // Pass 2: one deposit of exactly the payout, around the stay.
  for (const r of rs) {
    if (!open(r)) continue;
    const hit = pool
      .filter((p) => free(p, r) && p.amountCents === cents(r.payout) && nearStay(p, r))
      .sort(byCloseness(r))[0];
    if (hit) take(r, [hit]);
  }
  // Pass 3 (VRBO-style): a ~30% deposit after booking plus the balance before the stay, adding up exactly.
  for (const r of rs) {
    if (!open(r)) continue;
    const target = cents(r.payout);
    const window = pool.filter((p) => free(p, r) && p.date >= earliest(r) && p.date <= addDays(r.check_out, 10));
    let best: [LedgerRow, LedgerRow] | null = null;
    const gap = (b: LedgerRow) => Math.abs(dayNumber(b.date) - dayNumber(r.check_in));
    for (const a of window) {
      if (a.amountCents < target * 0.28 || a.amountCents > target * 0.32) continue;
      const b = window.find((x) => x !== a && x.date >= a.date && x.amountCents === target - a.amountCents);
      if (b && (!best || gap(b) < gap(best[1]))) best = [a, b];
    }
    if (best) take(r, best);
  }
  return { matched, taggedDiffers, used, pool };
}

/** Everything that doesn't depend on which month is viewed: parsed statements and the cross-month claims. */
export interface ManagerContext {
  propertyId: number;
  statements: { docId: number; month: string; statement: ParsedStatement }[];
  claims: Claims;
}

export function managerContext(db: DB, propertyId: number, extra?: ParsedStatement): ManagerContext {
  const statements = savedStatements(db, propertyId);
  const byId = new Map<string, Reservation>();
  for (const s of statements) for (const r of s.statement.reservations) byId.set(r.reservation_id, r);
  // A statement passed in directly wins over a saved copy of the same reservations.
  for (const r of extra?.reservations ?? []) byId.set(r.reservation_id, r);
  return { propertyId, statements, claims: claimDeposits(db, propertyId, [...byId.values()]) };
}

function analyze(db: DB, input: PreviewInput, ctx?: ManagerContext): Analysis {
  const propertyId = resolvePropertyId(db, input.property_id ?? input.property);
  const direct =
    input.statement_csv != null || input.statement != null || input.invoice_text != null || input.invoice != null;
  let statement: ParsedStatement | null = input.statement
    ? { reservations: input.statement.reservations, totals: totalsOf(input.statement.reservations), warnings: [] }
    : input.statement_csv != null
      ? parseStatementCsv(input.statement_csv)
      : null;
  let invoices: InvoiceInput[] = input.invoice
    ? [{ ...input.invoice, warnings: [], documentId: null }]
    : input.invoice_text != null
      ? [{ ...parseInvoiceText(input.invoice_text), documentId: null }]
      : [];
  const context =
    ctx && ctx.propertyId === propertyId && !statement ? ctx : managerContext(db, propertyId, statement ?? undefined);
  const month =
    input.month ??
    (statement ? statementMonth(statement) : invoices[0] ? invoiceMonth(invoices[0], context.statements) : null);
  if (!month) throw badRequest("Couldn't tell which month this covers; pass month (YYYY-MM)");

  // Nothing passed in: review the month's saved documents.
  const documents = listDocuments(db, propertyId, { month });
  const warnings: string[] = [];
  if (!direct) {
    const texts = docTexts(db, propertyId).filter((d) => d.month === month);
    if (!texts.length) throw badRequest(`No saved statement or invoice for ${month}`);
    const statementDocs = texts.filter((d) => d.kind === "statement");
    if (statementDocs.length > 1)
      warnings.push(`${month} has ${statementDocs.length} statements saved; using the latest`);
    const sDoc = statementDocs.at(-1);
    if (sDoc) {
      try {
        statement = parseStatementCsv(sDoc.text);
      } catch (e) {
        warnings.push(`The saved statement couldn't be read: ${(e as Error).message}`);
      }
    }
    for (const d of texts.filter((t) => t.kind === "invoice")) {
      try {
        invoices.push({ ...parseInvoiceText(d.text), documentId: d.id });
      } catch (e) {
        warnings.push(`A saved invoice couldn't be read: ${(e as Error).message}`);
      }
    }
  }
  invoices = invoices.sort((a, b) => (a.issued ?? "").localeCompare(b.issued ?? ""));

  const subcategory = input.subcategory ?? defaultManagerSubcategory(db, propertyId);
  const allCats = listCategories(db, false);
  const categoryByName = new Map(allCats.map((c) => [c.name.toLowerCase(), c]));
  const incomeCategory = categoryByName.get("rental income") ?? allCats.find((c) => c.kind === "income") ?? null;
  warnings.push(...(statement?.warnings ?? []));
  for (const inv of invoices)
    warnings.push(...(inv.warnings ?? []).map((w) => (invoices.length > 1 ? `Invoice ${inv.number}: ${w}` : w)));
  const checks: Check[] = [];
  /** Warning text -> the text its "explained" key is hashed from, when the wording changed after people explained it. */
  const keyTextOf = new Map<string, string>();

  // ---------- income ----------
  const income: IncomeRowView[] = [];
  let unlisted: Analysis["unlisted"] = [];
  const { claims } = context;
  if (statement) {
    const rs = [...statement.reservations].sort((a, b) => a.check_in.localeCompare(b.check_in));
    // Pass 4, for this month only: one deposit around the stay that's close but not equal (an adjustment, refund or
    // resolution), from what no statement claimed exactly.
    const used = new Set(claims.used);
    const differs = new Map<string, LedgerRow[]>(
      rs
        .filter((r) => claims.taggedDiffers.has(r.reservation_id))
        .map((r) => [r.reservation_id, claims.taggedDiffers.get(r.reservation_id)!]),
    );
    for (const r of rs) {
      if (claims.matched.has(r.reservation_id) || differs.has(r.reservation_id)) continue;
      const target = cents(r.payout);
      const hit = claims.pool
        .filter(
          (p) => !used.has(p.id) && !otherTag(p) && nearStay(p, r) && Math.abs(p.amountCents - target) <= target * 0.25,
        )
        .sort(byCloseness(r))[0]; // the deposit right after check-in, as Airbnb pays
      if (hit) {
        used.add(hit.id);
        differs.set(r.reservation_id, [hit]);
      }
    }
    const view = (rows: LedgerRow[]) => rows.map((h) => ({ id: h.id, date: h.date, amount: h.amountCents / 100 }));
    for (const r of rs) {
      const hits = claims.matched.get(r.reservation_id);
      const close = differs.get(r.reservation_id);
      if (hits)
        income.push({
          ...r,
          status: "matched",
          transaction_id: hits[0]!.id,
          transaction_date: hits[0]!.date,
          transactions: view(hits),
          tagged: hits.every((h) => h.description.includes(r.reservation_id)),
        });
      else if (close)
        income.push({
          ...r,
          status: "differs",
          transaction_id: close[0]!.id,
          transaction_date: close[0]!.date,
          transactions: view(close),
          difference: (close.reduce((sum, h) => sum + h.amountCents, 0) - cents(r.payout)) / 100,
          tagged: close.every((h) => h.description.includes(r.reservation_id)),
        });
      else if (isAirbnb(r)) income.push({ ...r, status: "missing", suggested_date: addDays(r.check_in, 2) });
      // Never offered for creation: the Stripe transfer that paid it is probably recorded already, mixed with others.
      else income.push({ ...r, status: "batched" });
    }
    // Deposits in this month that no statement explains (tagged ones belong to their reservation's statement).
    unlisted = ledgerRows(db, propertyId, "income", `${month}-01`, lastDayOfMonth(month))
      .filter((p) => !used.has(p.id) && !otherTag(p))
      .map((p) => ({ id: p.id, date: p.date, amount: p.amountCents / 100 }));

    const matched = income.filter((i) => i.status === "matched").length;
    const missing = income.filter((i) => i.status === "missing");
    checks.push({
      level: missing.length ? "warn" : "ok",
      code: "income",
      text: missing.length
        ? `${matched} of ${income.length} payouts are in the ledger; ${missing.length} Airbnb payout${missing.length === 1 ? "" : "s"} missing`
        : `${matched} of ${income.length} payouts tied to deposits; none missing`,
    });
    // One warning per stay, so each can be marked as explained on its own.
    for (const i of income.filter((x) => x.status === "differs")) {
      const text = differenceText(i);
      warnings.push(text);
      keyTextOf.set(text, legacyDifferenceText(i));
    }
    const batched = income.filter((i) => i.status === "batched");
    if (batched.length)
      checks.push({
        level: "info",
        text: `${batched.length === 1 ? "A" : batched.length} ${channelLabel(batched)} payout${batched.length === 1 ? "" : "s"} (${usd(batched.reduce((sum, i) => sum + cents(i.payout), 0))}) couldn't be tied to a deposit. These are paid through Stripe, which often combines several bookings (and deposits for future stays) into one transfer, so nothing is offered to add`,
      });
    if (unlisted.length)
      checks.push({
        level: "info",
        text: `${unlisted.length === 1 ? "A deposit" : `${unlisted.length} deposits`} recorded in ${month} (${usd(unlisted.reduce((sum, u) => sum + cents(u.amount), 0))}) ${unlisted.length === 1 ? "isn't" : "aren't"} explained by any saved statement: likely a stay on a statement you haven't added yet, or a Stripe transfer for VRBO / direct bookings`,
      });
  }

  // ---------- invoices ----------
  const lines: LineView[] = [];
  const date = lastDayOfMonth(month);
  const invoiceTotal = invoices.reduce((sum, inv) => sum + inv.lines.reduce((s, l) => s + cents(l.amount), 0), 0);
  if (invoices.length) {
    const history = db
      .select({ description: transactions.description, category: categories.name })
      .from(transactions)
      .innerJoin(categories, eq(categories.id, transactions.categoryId))
      .where(
        and(
          isNull(transactions.deletedAt),
          eq(transactions.propertyId, propertyId),
          eq(categories.kind, "expense"),
          subcategory ? eq(transactions.subcategory, subcategory) : undefined,
          sql`${transactions.description} <> ''`,
        ),
      )
      .limit(3000)
      .all();
    const flat = invoices.flatMap((inv) => inv.lines.map((l, i) => ({ l, i, inv })));
    const pool = ledgerRows(db, propertyId, "expense", `${month}-01`, date);
    const used = new Set<number>();
    const suggested = flat.map((f) => suggestCategory(f.l.item, history, categoryByName));
    const matchOf = new Map<number, LedgerRow>();
    // Strict pass: same amount and category. Loose pass: same amount on this manager's rows (category may differ);
    // without a manager subcategory there is nothing to tell their rows from any other purchase, so skip it.
    for (const strict of subcategory ? [true, false] : [true]) {
      flat.forEach((f, n) => {
        if (matchOf.has(n)) return;
        const hit = pool.find(
          (p) =>
            !used.has(p.id) &&
            p.amountCents === -cents(f.l.amount) &&
            (strict ? suggested[n] != null && p.categoryId === suggested[n]!.id : p.subcategory === subcategory),
        );
        if (hit) {
          used.add(hit.id);
          matchOf.set(n, hit);
        }
      });
    }
    const catById = new Map(allCats.map((c) => [c.id, c]));
    flat.forEach((f, n) => {
      const hit = matchOf.get(n);
      const cat = suggested[n];
      const ledgerCat = hit ? catById.get(hit.categoryId)?.name : undefined;
      lines.push({
        ...f.l,
        key: `${f.inv.number || f.inv.documentId || "invoice"}#${f.i}`,
        index: n,
        invoice: f.inv.number,
        document_id: f.inv.documentId,
        category: cat?.name ?? null,
        category_id: cat?.id ?? null,
        status: hit ? "exists" : cat ? "missing" : "uncategorized",
        transaction_id: hit?.id,
        ledger_category: hit && ledgerCat && ledgerCat !== cat?.name ? ledgerCat : undefined,
        date,
      });
    });

    const todo = lines.filter((l) => l.status !== "exists");
    checks.push({
      level: todo.length ? "warn" : "ok",
      code: "lines",
      text: todo.length
        ? `${lines.length - todo.length} of ${lines.length} invoice lines are in the ledger; ${todo.length} missing (${usd(todo.reduce((s, l) => s + cents(l.amount), 0))})`
        : `All ${lines.length} invoice lines (${usd(invoiceTotal)}) are in the ledger`,
    });
    for (const inv of invoices) {
      const sum = inv.lines.reduce((s, l) => s + cents(l.amount), 0);
      const label = invoices.length > 1 ? `Invoice ${inv.number}` : "Invoice";
      if (inv.total != null && cents(inv.total) === sum)
        checks.push({ level: "ok", text: `${label} lines add up to its total (${usd(sum)})` });
      // a mismatch is already a parse warning
    }
    if (subcategory) {
      const ledgerTotal = -pool.filter((p) => p.subcategory === subcategory).reduce((s, p) => s + p.amountCents, 0);
      const after = ledgerTotal + todo.reduce((s, l) => s + cents(l.amount), 0);
      checks.push(
        after === invoiceTotal
          ? {
              level: "ok",
              text: `${subcategory} charges in ${month} ${todo.length ? "will total" : "total"} ${usd(invoiceTotal)}, the invoice amount`,
            }
          : {
              level: "warn",
              text: `${subcategory} charges in ${month} ${todo.length ? "would total" : "total"} ${usd(after)} but the invoice${invoices.length > 1 ? "s total" : " is"} ${usd(invoiceTotal)}; the ledger has rows for this manager that aren't on the invoice (or the reverse)`,
            },
      );
    }
    for (const inv of invoices)
      if (inv.paid)
        checks.push({
          level: "info",
          text: `Invoice ${inv.number} was paid ${shortDate(inv.paid)} ${inv.paid.slice(0, 4)}; its lines are dated ${shortDate(date)} (end of the service month), like your earlier months`,
        });
  }

  // ---------- statement vs invoice ----------
  if (statement && invoices.length) {
    const allLines = invoices.flatMap((inv) => inv.lines);
    const sumOf = (re: RegExp) =>
      allLines.filter((l) => re.test(norm(l.item))).reduce((s, l) => s + cents(l.amount), 0);
    const mgmtInv = sumOf(/^manage/);
    const mgmtCsv = cents(statement.totals.management_fee);
    if (mgmtInv && mgmtCsv)
      checks.push(
        mgmtInv === mgmtCsv
          ? { level: "ok", text: `Management fee matches: ${usd(mgmtInv)} on both` }
          : { level: "warn", text: `Management fee differs: invoice ${usd(mgmtInv)} vs statement ${usd(mgmtCsv)}` },
      );
    // "Cleaning" / "September Cleaning" are the per-stay cleanings; a deep clean is an extra.
    const cleanInv = allLines
      .filter((l) => /\bcleaning\b/.test(norm(l.item)) && !/deep/.test(norm(l.item)))
      .reduce((sum, l) => sum + cents(l.amount), 0);
    const cleanCsv = cents(statement.totals.cleaning_fee);
    const stays = statement.reservations.length;
    if (cleanInv && cleanCsv)
      checks.push({
        level: cleanInv === cleanCsv ? "ok" : "info",
        text:
          cleanInv === cleanCsv
            ? `Cleaning matches: ${usd(cleanInv)} on both`
            : `Cleaning: you were billed ${usd(cleanInv)}; guests paid ${usd(cleanCsv)} in cleaning fees across ${stays} stay${stays === 1 ? "" : "s"}`,
      });
    // VRBO / direct bookings: the manager bills the damage waiver and the VRBO commission back on the invoice.
    for (const [label, re, key] of [
      ["Insurance waiver", /insurance waiver/, "insurance_waiver"],
      ["VRBO commission", /commission/, "commission"],
    ] as const) {
      const inv = sumOf(re);
      const csv = cents(statement.totals[key]);
      if (!inv && !csv) continue;
      checks.push(
        inv === csv
          ? { level: "ok", text: `${label} matches: ${usd(inv)} on both` }
          : {
              level: "warn",
              text: `${label} differs: invoice ${usd(inv)} vs statement ${usd(csv)}${inv ? "" : " (not billed on this invoice; it may come on a later one)"}`,
            },
      );
    }
  }
  if (statement && statement.totals.taxes)
    checks.push({
      level: "info",
      text: `Payouts include ${usd(cents(statement.totals.taxes))} of lodging tax collected from guests on VRBO / direct bookings`,
    });
  if (!direct && !statement) warnings.push(`No owner statement saved for ${month} yet`);
  if (!direct && !invoices.length) warnings.push(`No invoice saved for ${month} yet`);
  for (const w of warnings) checks.push({ level: "warn", text: w });
  // Warnings can be marked as explained; their key follows the text, so a changed amount asks again.
  const acks = new Map(
    db
      .select()
      .from(managerAcknowledgements)
      .where(and(eq(managerAcknowledgements.propertyId, propertyId), eq(managerAcknowledgements.month, month)))
      .all()
      .map((a) => [a.checkKey, a]),
  );
  for (const c of checks) {
    if (c.level !== "warn" || c.code) continue;
    c.key = `w:${createHash("sha1")
      .update(keyTextOf.get(c.text) ?? c.text)
      .digest("hex")
      .slice(0, 12)}`;
    const ack = acks.get(c.key);
    if (ack) {
      c.level = "info";
      c.explained = { note: ack.note, at: ack.createdAt };
    }
  }

  return {
    propertyId,
    month,
    subcategory,
    statement,
    invoices,
    documents,
    income,
    unlisted,
    lines,
    checks,
    warnings,
    incomeCategory,
  };
}

function view(db: DB, a: Analysis) {
  const toCheck = a.checks.filter((c) => c.level === "warn" && !c.code).length;
  const toAdd =
    a.income.filter((i) => i.status === "missing").length + a.lines.filter((l) => l.status !== "exists").length;
  return {
    property_id: a.propertyId,
    month: a.month,
    subcategory: a.subcategory,
    documents: a.documents,
    /** Parsed inputs, so a client can send them back to apply without re-uploading files. */
    statement: a.statement && { reservations: a.statement.reservations },
    invoices: a.invoices.map((inv) => ({
      number: inv.number,
      issued: inv.issued,
      paid: inv.paid,
      total: inv.total,
      document_id: inv.documentId,
    })),
    /** The first invoice, in the shape apply accepts (for single-invoice callers). */
    invoice:
      a.invoices.length === 1
        ? {
            number: a.invoices[0]!.number,
            issued: a.invoices[0]!.issued,
            paid: a.invoices[0]!.paid,
            total: a.invoices[0]!.total,
            lines: a.invoices[0]!.lines,
          }
        : null,
    totals: a.statement?.totals ?? null,
    income: a.income,
    unlisted_income: a.unlisted,
    lines: a.lines,
    checks: a.checks,
    categories: listCategories(db, false)
      .filter((c) => c.kind === "expense")
      .map((c) => ({ id: c.id, name: c.name })),
    summary: {
      income_missing: a.income.filter((i) => i.status === "missing").length,
      lines_missing: a.lines.filter((l) => l.status !== "exists").length,
      to_add: toAdd,
      to_check: toCheck,
    },
  };
}

export function previewManagerMonth(db: DB, raw: unknown, ctx?: ManagerContext) {
  return view(db, analyze(db, previewInput.parse(raw), ctx));
}

/** One row per month of the year: which documents are saved and what still needs doing. */
export function managerYear(db: DB, raw: { year: number; property?: number | string }) {
  const propertyId = resolvePropertyId(db, raw.property);
  const docs = listDocuments(db, propertyId, { year: raw.year });
  const ctx = managerContext(db, propertyId);
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const month = `${raw.year}-${String(m).padStart(2, "0")}`;
    const mine = docs.filter((d) => d.month === month);
    const base = {
      month,
      statement: mine.find((d) => d.kind === "statement") ?? null,
      invoices: mine.filter((d) => d.kind === "invoice"),
    };
    if (!mine.length) {
      months.push({ ...base, status: "empty" as const, to_add: 0, to_check: 0, payouts: 0, invoice_total: 0 });
      continue;
    }
    try {
      const p = previewManagerMonth(db, { property_id: propertyId, month }, ctx);
      months.push({
        ...base,
        status: p.summary.to_add ? ("todo" as const) : p.summary.to_check ? ("check" as const) : ("done" as const),
        to_add: p.summary.to_add,
        to_check: p.summary.to_check,
        payouts: p.income.reduce((s, i) => s + cents(i.payout), 0) / 100,
        invoice_total: p.lines.reduce((s, l) => s + cents(l.amount), 0) / 100,
      });
    } catch (e) {
      months.push({
        ...base,
        status: "error" as const,
        error: (e as Error).message,
        to_add: 0,
        to_check: 0,
        payouts: 0,
        invoice_total: 0,
      });
    }
  }
  return { year: raw.year, property_id: propertyId, months };
}

// ======================= apply =======================

/** Whether an earlier save already flagged this deposit (recorded as `flagged` on its manager_statement audit row). */
function flaggedBefore(db: DB, transactionId: number) {
  return !!db.get<{ one: number }>(
    sql`SELECT 1 AS one FROM ${auditLog}, json_each(${auditLog.changes}, '$.flagged') j
        WHERE ${auditLog.entity} = 'manager_statement' AND j.value = ${transactionId} LIMIT 1`,
  );
}

export function applyManagerMonth(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const input = applyInput.parse(raw);
  return tx(db, () => {
    const a = analyze(db, input);
    const result = {
      month: a.month,
      tagged: [] as number[],
      /** Deposits flagged for review because they differ from the statement. */
      flagged: [] as number[],
      created_income: [] as number[],
      created_expenses: [] as number[],
      skipped: [] as string[],
      /** The management-fee row (else the first invoice line): where the statement CSV is attached. */
      anchor_transaction_id: null as number | null,
      /** Every invoice line's entry (existing or just created), in invoice order: the invoice PDF is each one's receipt. */
      invoice_transaction_ids: [] as number[],
      /** Same, with the saved invoice document each line came from. */
      line_transactions: [] as { key: string; document_id: number | null; transaction_id: number }[],
    };

    if (input.tag_income)
      for (const r of a.income) {
        // Only exact matches: tagging a "differs" guess would make it look settled on the next review.
        if (r.status !== "matched" || r.tagged) continue;
        for (const t of r.transactions ?? []) {
          const row = db
            .select({ d: transactions.description })
            .from(transactions)
            .where(eq(transactions.id, t.id))
            .get();
          // Only fill empty descriptions: never overwrite what someone wrote. Don't touch reference/external_id:
          // those drive duplicate detection and the Grist re-import.
          if (row && row.d === "") {
            const part =
              (r.transactions?.length ?? 0) > 1 ? (t === r.transactions![0] ? ", deposit" : ", balance") : "";
            updateTransaction(db, actor, t.id, {
              description: `Reservation ${r.reservation_id} (check-in ${r.check_in}${part})`,
            });
            result.tagged.push(t.id);
          }
        }
      }

    // A deposit that differs from the statement is flagged for review once (the audit log remembers it), so clearing
    // the flag by hand sticks on the next save.
    for (const r of a.income) {
      if (r.status !== "differs") continue;
      for (const t of r.transactions ?? []) {
        const row = db
          .select({ flagged: transactions.needsReview })
          .from(transactions)
          .where(eq(transactions.id, t.id))
          .get();
        if (!row || row.flagged || flaggedBefore(db, t.id)) continue;
        const fee = feeOnShortfall(r);
        updateTransaction(db, actor, t.id, {
          needs_review: true,
          review_note:
            `The owner statement shows ${usd(cents(r.payout))} for reservation ${r.reservation_id} (check-in ${r.check_in}); this deposit is ${differenceAmount(r)}. Ask the manager about the difference` +
            (fee ? ` (about ${usd(fee)} of the management fee may be on it).` : "."),
        });
        result.flagged.push(t.id);
      }
    }

    for (const id of input.create_income) {
      const r = a.income.find((i) => i.reservation_id === id);
      if (!r || r.status !== "missing") {
        result.skipped.push(`Reservation ${id}: not missing from the ledger`);
        continue;
      }
      if (!a.incomeCategory) throw badRequest("No income category exists to book the payout under");
      const created = createTransaction(
        db,
        actor,
        {
          property_id: a.propertyId,
          date: r.suggested_date!,
          amount: r.payout,
          category_id: a.incomeCategory.id,
          vendor: /airbnb/i.test(r.channel) ? "Airbnb" : "",
          description: `Reservation ${r.reservation_id} (check-in ${r.check_in})`,
          needs_review: true,
          review_note:
            "Created from the owner statement; the deposit date is estimated (check-in + 2 days). Confirm against your bank.",
        },
        { source: "manager-statement" },
      );
      result.created_income.push(created.id);
    }

    const lineTx = new Map<string, number>();
    for (const l of a.lines) if (l.transaction_id) lineTx.set(l.key, l.transaction_id);
    const find = (k: number | string) => (typeof k === "number" ? a.lines[k] : a.lines.find((l) => l.key === k));
    for (const k of new Set(input.create_lines)) {
      const l = find(k);
      if (!l || l.status === "exists") {
        result.skipped.push(`Invoice line ${k}: ${l ? "already in the ledger" : "doesn't exist"}`);
        continue;
      }
      const o = input.overrides[l.key] ?? input.overrides[String(l.index)];
      const category = o?.category != null ? o.category : l.category_id;
      if (category == null) throw badRequest(`Invoice line "${l.item}" needs a category`);
      const created = createTransaction(
        db,
        actor,
        {
          property_id: a.propertyId,
          date: l.date,
          amount: -l.amount,
          category: typeof category === "number" ? undefined : category,
          category_id: typeof category === "number" ? category : undefined,
          subcategory: a.subcategory,
          description: o?.description ?? (l.description || l.item),
          reference: l.invoice ? `Invoice ${l.invoice}` : "",
        },
        { source: "manager-statement" },
      );
      result.created_expenses.push(created.id);
      lineTx.set(l.key, created.id);
    }

    result.line_transactions = a.lines.flatMap((l) =>
      lineTx.has(l.key) ? [{ key: l.key, document_id: l.document_id, transaction_id: lineTx.get(l.key)! }] : [],
    );
    result.invoice_transaction_ids = result.line_transactions.map((x) => x.transaction_id);
    const mgmt = a.lines.find((l) => /^manage/.test(norm(l.item)));
    result.anchor_transaction_id = (mgmt && lineTx.get(mgmt.key)) ?? result.invoice_transaction_ids[0] ?? null;
    audit(db, actor, "import", "manager_statement", null, {
      month: a.month,
      tagged: result.tagged.length,
      flagged: result.flagged,
      created_income: result.created_income,
      created_expenses: result.created_expenses,
    });
    return result;
  });
}

// ======================= explained checks =======================

export const acknowledgeInput = z.object({
  property: ref.optional(),
  property_id: z.number().int().optional(),
  month: z.string().regex(MONTH, "Use YYYY-MM"),
  key: z.string().min(1).max(100).describe("The check's key from the month review"),
  note: z.string().trim().max(1000).default("").describe("Why it's fine, e.g. what the manager said"),
});

/** Mark a warning as explained so it stops counting as a to-do (the note shows on the month). */
export function acknowledgeCheck(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const i = acknowledgeInput.parse(raw);
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  db.insert(managerAcknowledgements)
    .values({ propertyId, month: i.month, checkKey: i.key, note: i.note, createdBy: actor.user.id })
    .onConflictDoUpdate({
      target: [managerAcknowledgements.propertyId, managerAcknowledgements.month, managerAcknowledgements.checkKey],
      set: { note: i.note },
    })
    .run();
  audit(db, actor, "acknowledge", "manager_check", null, { month: i.month, key: i.key, note: i.note });
  return { month: i.month, key: i.key, explained: true };
}

export function unacknowledgeCheck(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const i = acknowledgeInput.omit({ note: true }).parse(raw);
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  db.delete(managerAcknowledgements)
    .where(
      and(
        eq(managerAcknowledgements.propertyId, propertyId),
        eq(managerAcknowledgements.month, i.month),
        eq(managerAcknowledgements.checkKey, i.key),
      ),
    )
    .run();
  audit(db, actor, "unacknowledge", "manager_check", null, { month: i.month, key: i.key });
  return { month: i.month, key: i.key, explained: false };
}

/** Months (any year) whose saved paperwork has entries to add or warnings nobody has explained. For the to-do list. */
export function managerAttention(db: DB, opts: { propertyId?: number } = {}) {
  const props = opts.propertyId
    ? [opts.propertyId]
    : [
        ...new Set(
          db
            .selectDistinct({ id: managerDocuments.propertyId })
            .from(managerDocuments)
            .where(propertyScope(db, managerDocuments.propertyId))
            .all()
            .map((r) => r.id),
        ),
      ];
  const out: { property_id: number; month: string; to_add: number; to_check: number }[] = [];
  for (const propertyId of props) {
    const months = [
      ...new Set(
        db
          .selectDistinct({ month: managerDocuments.month })
          .from(managerDocuments)
          .where(eq(managerDocuments.propertyId, propertyId))
          .all()
          .map((r) => r.month),
      ),
    ].sort();
    if (!months.length) continue;
    const ctx = managerContext(db, propertyId);
    for (const month of months) {
      try {
        const p = previewManagerMonth(db, { property_id: propertyId, month }, ctx);
        if (p.summary.to_add || p.summary.to_check)
          out.push({ property_id: propertyId, month, to_add: p.summary.to_add, to_check: p.summary.to_check });
      } catch {
        out.push({ property_id: propertyId, month, to_add: 0, to_check: 1 });
      }
    }
  }
  return out;
}
