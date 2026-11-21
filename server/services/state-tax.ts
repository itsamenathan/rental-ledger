/**
 * Quarterly state sales tax on the stays the state taxes through the owner (Colorado: every booking channel except
 * Airbnb, which collects and remits its own). The return is filed per property under its Location ID, by the 20th of
 * the month after the quarter ends, with only the GROSS: the state works out the tax, so the app never computes tax
 * or needs a rate.
 *
 * - Gross = the manager's owner payout of every non-Airbnb, non-cancelled reservation whose CHECK-IN falls in the
 *   quarter (a Mar 31 → Apr 2 stay is Q1), read from every saved manager statement once per reservation id
 *   (`savedReservations`), so a stay on the next month's statement still counts in its own quarter.
 * - A quarter is "paid" when it has a state_tax_filings row; otherwise it's open, and overdue once its due date (always
 *   derived from year + quarter, never stored) has passed. There is no other status.
 * - Paying records the expense in the ledger the way the owner always has: category Taxes, no subcategory, negative,
 *   direct, linked to the filing. An existing expense can be linked instead, so a quarter paid before the app knew
 *   about it isn't entered twice.
 * - Clearing a filing keeps the linked expense unless asked to move it to the trash (it may have been edited since).
 */
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { categories, managerDocuments, properties, stateTaxFilings, transactions, users } from "../db/schema.ts";
import { AppError, audit, badRequest, cents, requireWrite, type Actor } from "../context.ts";
import {
  createTransaction,
  deleteTransaction,
  getProperty,
  resolveCategory,
  resolvePropertyId,
  type Transaction,
} from "./ledger.ts";
import { isAirbnb, savedReservations, savedStatements } from "./manager-statement.ts";
import { claimUploads, uploadIds } from "./uploads.ts";

/** The category the payment is recorded under (the owner's convention: Taxes, no subcategory, direct). */
export const STATE_TAX_CATEGORY = "Taxes";
/** Day of the month after the quarter ends that the return is due. */
const DUE_DAY = 20;
/** The To do list asks this many days before the due date (and every day after it, until paid). */
export const REMIND_DAYS = 14;
/** How far back an unpaid quarter is still reported as overdue. */
const OVERDUE_LOOKBACK_QUARTERS = 4;

const pad = (n: number) => String(n).padStart(2, "0");
const dayNumber = (iso: string) => Math.round(Date.parse(iso + "T00:00:00Z") / 86_400_000);
const todayIso = () => new Date().toISOString().slice(0, 10);
const usd = (c: number) =>
  (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

// ======================= quarter arithmetic =======================

export interface QuarterRef {
  year: number;
  quarter: number;
}

export const quarterOf = (date: string): QuarterRef => ({
  year: Number(date.slice(0, 4)),
  quarter: Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1,
});

/** The quarter's three months, YYYY-MM. */
export const quarterMonths = ({ year, quarter }: QuarterRef) =>
  [1, 2, 3].map((i) => `${year}-${pad((quarter - 1) * 3 + i)}`);

export function quarterRange(q: QuarterRef) {
  const months = quarterMonths(q);
  const last = months[2]!;
  const end = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return { start: `${months[0]}-01`, end };
}

/** The 20th of the month after the quarter: Apr 20, Jul 20, Oct 20, and Jan 20 of the next year for Q4. */
export function dueDate({ year, quarter }: QuarterRef) {
  return quarter === 4 ? `${year + 1}-01-${DUE_DAY}` : `${year}-${pad(quarter * 3 + 1)}-${DUE_DAY}`;
}

const prevQuarter = ({ year, quarter }: QuarterRef): QuarterRef =>
  quarter === 1 ? { year: year - 1, quarter: 4 } : { year, quarter: quarter - 1 };
const nextMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
};
const monthLabel = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
export const quarterLabel = ({ year, quarter }: QuarterRef) => `Q${quarter} ${year}`;

/**
 * open: ended, not paid, due date not passed. overdue: past the due date, not paid. in_progress: the quarter hasn't
 * ended. paid: a filing is recorded. Only "paid" is stored (as the filing row).
 */
export type QuarterStatus = "paid" | "overdue" | "open" | "in_progress";

function statusOf(q: QuarterRef, paid: boolean, today: string): QuarterStatus {
  if (paid) return "paid";
  if (today > dueDate(q)) return "overdue";
  if (today > quarterRange(q).end) return "open";
  return "in_progress";
}

// ======================= filings (read side) =======================

const filingCols = {
  id: stateTaxFilings.id,
  property_id: stateTaxFilings.propertyId,
  year: stateTaxFilings.year,
  quarter: stateTaxFilings.quarter,
  gross_filed: sql<number | null>`${stateTaxFilings.grossFiledCents} / 100.0`,
  amount_paid: sql<number>`${stateTaxFilings.amountPaidCents} / 100.0`,
  paid_date: stateTaxFilings.paidDate,
  confirmation: stateTaxFilings.confirmation,
  transaction_id: stateTaxFilings.transactionId,
  created_at: stateTaxFilings.createdAt,
  created_by: users.email,
  updated_at: stateTaxFilings.updatedAt,
};

function selectFilings(db: DB) {
  return db.select(filingCols).from(stateTaxFilings).leftJoin(users, eq(users.id, stateTaxFilings.createdBy));
}
type FilingRow = NonNullable<ReturnType<ReturnType<typeof selectFilings>["get"]>>;

function findFiling(db: DB, propertyId: number, q: QuarterRef) {
  return selectFilings(db)
    .where(
      and(
        eq(stateTaxFilings.propertyId, propertyId),
        eq(stateTaxFilings.year, q.year),
        eq(stateTaxFilings.quarter, q.quarter),
      ),
    )
    .get();
}

/** The linked ledger expense as it is now, and anything that no longer agrees with the filing. */
function linkedExpense(db: DB, f: FilingRow) {
  if (f.transaction_id == null) return { expense: null, expense_warning: null };
  const t = db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: sql<number>`${transactions.amountCents} / 100.0`,
      amount_cents: transactions.amountCents,
      category: categories.name,
      subcategory: transactions.subcategory,
      allocation: transactions.allocation,
      deleted: sql<boolean>`${transactions.deletedAt} IS NOT NULL`,
    })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(eq(transactions.id, f.transaction_id))
    .get();
  if (!t) return { expense: null, expense_warning: null };
  const { amount_cents, ...expense } = t;
  const deleted = Boolean(t.deleted);
  let warning: string | null = null;
  if (deleted) warning = "The linked expense is in the trash; restore it or clear this payment and record it again.";
  else if (-amount_cents !== Math.round(f.amount_paid * 100))
    warning = `The linked expense is ${usd(-amount_cents)}, not the ${usd(Math.round(f.amount_paid * 100))} paid.`;
  return { expense: { ...expense, deleted }, expense_warning: warning };
}

// ======================= the quarter report =======================

export interface StateTaxReservation {
  reservation_id: string;
  channel: string;
  guest: string;
  check_in: string;
  check_out: string;
  nights: number;
  payout: number;
  taxes: number;
  /** the saved statement (YYYY-MM) it was read from */
  statement_month: string;
}

interface QuarterInputs {
  statements: ReturnType<typeof savedStatements>;
  reservations: ReturnType<typeof savedReservations>;
  /** months with a saved statement document, readable or not */
  docMonths: Set<string>;
}

function inputsFor(db: DB, propertyId: number): QuarterInputs {
  const statements = savedStatements(db, propertyId);
  const docMonths = new Set(
    db
      .selectDistinct({ month: managerDocuments.month })
      .from(managerDocuments)
      .where(and(eq(managerDocuments.propertyId, propertyId), eq(managerDocuments.kind, "statement")))
      .all()
      .map((r) => r.month),
  );
  return { statements, reservations: savedReservations(db, propertyId, statements), docMonths };
}

function buildQuarter(db: DB, propertyId: number, q: QuarterRef, today: string, inputs: QuarterInputs) {
  const { start, end } = quarterRange(q);
  const inQuarter = inputs.reservations
    .filter((r) => r.check_in >= start && r.check_in <= end)
    .sort((a, b) => a.check_in.localeCompare(b.check_in) || a.reservation_id.localeCompare(b.reservation_id));
  const counted = inQuarter.filter((r) => !r.cancelled && !isAirbnb(r));
  const airbnb = inQuarter.filter((r) => !r.cancelled && isAirbnb(r));
  const cancelled = inQuarter.filter((r) => r.cancelled && !isAirbnb(r));
  const sum = (rs: typeof inQuarter, k: "payout" | "taxes") => rs.reduce((s, r) => s + cents(r[k]), 0);
  const grossCents = sum(counted, "payout");

  // Completeness: each ended month of the quarter needs a statement it can read, and stays that check in late in the
  // quarter's last month are often on the next month's statement.
  const readable = new Set(inputs.statements.map((s) => s.month));
  const months = quarterMonths(q);
  const warnings: string[] = [];
  const notes: string[] = [];
  const missing = months.filter((m) => !readable.has(m) && m < today.slice(0, 7));
  for (const m of missing)
    warnings.push(
      inputs.docMonths.has(m)
        ? `The saved ${monthLabel(m)} statement can't be read, so its stays aren't counted. Open it on the Manager page.`
        : `No manager statement is saved for ${monthLabel(m)}, so the gross is missing that month's stays.`,
    );
  const after = nextMonth(months[2]!);
  if (!readable.has(after) && today.slice(0, 7) > months[2]!)
    notes.push(
      `No statement for ${monthLabel(after)} yet: a stay that checks in late in ${monthLabel(months[2]!)} and checks out in ${monthLabel(after).split(" ")[0]} is on that statement, and would add to this quarter.`,
    );
  const noChannel = counted.filter((r) => !r.channel.trim());
  if (noChannel.length)
    warnings.push(
      `${noChannel.length} reservation${noChannel.length === 1 ? " has" : "s have"} no channel on the statement, so ${noChannel.length === 1 ? "it is" : "they are"} counted. Leave out any that were Airbnb.`,
    );

  const filing = findFiling(db, propertyId, q) ?? null;
  const status = statusOf(q, !!filing, today);
  const due = dueDate(q);
  return {
    year: q.year,
    quarter: q.quarter,
    label: quarterLabel(q),
    start,
    end,
    due_date: due,
    /** days until the due date (negative once overdue) */
    days_left: dayNumber(due) - dayNumber(today),
    status,
    /** sum of owner payouts of the counted reservations: the number to enter as the gross */
    gross: grossCents / 100,
    /** lodging tax the guests paid on the counted stays (the statement's taxes column), to cross-check only */
    taxes_collected: sum(counted, "taxes") / 100,
    reservations: counted.map(toView),
    excluded: {
      airbnb: { count: airbnb.length, payout: sum(airbnb, "payout") / 100 },
      cancelled: { count: cancelled.length, payout: sum(cancelled, "payout") / 100 },
    },
    statement_months: months.filter((m) => readable.has(m)),
    missing_months: missing,
    complete: missing.length === 0 && today > end,
    warnings,
    notes,
    filing: filing ? { ...filing, ...linkedExpense(db, filing) } : null,
  };
}
export type StateTaxQuarter = ReturnType<typeof buildQuarter>;

const toView = (r: ReturnType<typeof savedReservations>[number]): StateTaxReservation => ({
  reservation_id: r.reservation_id,
  channel: r.channel,
  guest: r.guest,
  check_in: r.check_in,
  check_out: r.check_out,
  nights: r.nights,
  payout: r.payout,
  taxes: r.taxes,
  statement_month: r.month,
});

const quarterSchema = z.number().int().min(1).max(4);
const yearSchema = z.number().int().min(2000).max(2100);

function propertyHeader(db: DB, propertyId: number) {
  const p = getProperty(db, propertyId);
  return { id: p.id, name: p.name, location_id: p.state_tax_location_id };
}

/** One quarter of one property: the gross and the reservations behind it, the due date and the payment if any. */
export function stateTaxQuarter(
  db: DB,
  opts: { property?: number | string; year: number; quarter: number; today?: string },
) {
  const propertyId = resolvePropertyId(db, opts.property);
  const q = { year: yearSchema.parse(opts.year), quarter: quarterSchema.parse(opts.quarter) };
  const today = opts.today ?? todayIso();
  return {
    property: propertyHeader(db, propertyId),
    ...buildQuarter(db, propertyId, q, today, inputsFor(db, propertyId)),
    candidates: linkCandidates(db, propertyId, q),
  };
}

/** The four quarters of a year for one property. */
export function stateTaxYear(db: DB, opts: { property?: number | string; year: number; today?: string }) {
  const propertyId = resolvePropertyId(db, opts.property);
  const year = yearSchema.parse(opts.year);
  const today = opts.today ?? todayIso();
  const inputs = inputsFor(db, propertyId);
  const quarters = [1, 2, 3, 4].map((quarter) => {
    const q = { year, quarter };
    return { ...buildQuarter(db, propertyId, q, today, inputs), candidates: linkCandidates(db, propertyId, q) };
  });
  return {
    property: propertyHeader(db, propertyId),
    year,
    category: STATE_TAX_CATEGORY,
    /** reminders on the To do list need a Location ID (or a recorded payment), so a property that doesn't file isn't nagged */
    reminders: remindersOn(db, propertyId),
    quarters,
  };
}

/**
 * Expenses that could be this quarter's payment, for "link an existing expense": the Taxes category, no subcategory,
 * paid between the quarter's start and two months after the due date, not already linked to a filing.
 */
function linkCandidates(db: DB, propertyId: number, q: QuarterRef) {
  const from = quarterRange(q).start;
  const due = dueDate(q);
  const to = new Date((dayNumber(due) + 60) * 86_400_000).toISOString().slice(0, 10);
  return db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: sql<number>`${transactions.amountCents} / 100.0`,
      vendor: transactions.vendor,
      description: transactions.description,
      allocation: transactions.allocation,
    })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        eq(transactions.propertyId, propertyId),
        isNull(transactions.deletedAt),
        eq(sql`lower(${categories.name})`, STATE_TAX_CATEGORY.toLowerCase()),
        eq(transactions.subcategory, ""),
        sql`${transactions.amountCents} < 0`,
        gte(transactions.date, from),
        lte(transactions.date, to),
        sql`NOT EXISTS (SELECT 1 FROM ${stateTaxFilings} WHERE ${stateTaxFilings.transactionId} = ${transactions.id})`,
      ),
    )
    .orderBy(transactions.date)
    .all();
}

// ======================= writes =======================

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s + "T00:00:00Z")), "Invalid date");
const ref = z.union([z.number().int(), z.string()]);

export const markPaidInput = z.object({
  property: ref.optional(),
  property_id: ref.optional(),
  year: yearSchema,
  quarter: quarterSchema,
  paid_date: isoDate.optional().describe("Date paid, YYYY-MM-DD (defaults to the linked expense's date)"),
  amount_paid: z
    .number()
    .finite()
    .positive()
    .max(1e8)
    .optional()
    .describe("Dollars paid, positive (required unless linking an expense, whose amount is used)"),
  gross_filed: z
    .number()
    .finite()
    .min(0)
    .max(1e9)
    .nullable()
    .optional()
    .describe(
      "Gross entered on the return; defaults to the gross computed from the manager statements when they cover the quarter",
    ),
  confirmation: z.string().trim().max(200).default("").describe("Confirmation number from the state's site"),
  transaction_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Link this existing Taxes expense instead of creating one"),
  upload_ids: uploadIds.optional().describe("Pending uploads (POST /api/uploads) to attach to the expense"),
});

export const clearInput = z.object({
  property: ref.optional(),
  property_id: ref.optional(),
  year: yearSchema,
  quarter: quarterSchema,
  trash_expense: z
    .boolean()
    .default(false)
    .describe("Also move the linked expense to the trash (restorable). By default it stays in the ledger."),
});

/**
 * Record a quarter as paid. Creates the ledger expense (Taxes, no subcategory, negative, direct) in the same database
 * transaction, or links `transaction_id`. Sending the same payment again returns the recorded filing unchanged (one
 * expense, ever); a different payment for a paid quarter is refused (409) until it's cleared.
 */
export function markStateTaxPaid(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const i = markPaidInput.parse(raw);
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  const q = { year: i.year, quarter: i.quarter };
  const label = quarterLabel(q);
  return tx(db, () => {
    const existing = findFiling(db, propertyId, q);
    if (existing) {
      const same =
        i.transaction_id != null
          ? existing.transaction_id === i.transaction_id
          : existing.paid_date === i.paid_date &&
            i.amount_paid != null &&
            Math.round(existing.amount_paid * 100) === cents(i.amount_paid);
      if (same) return stateTaxQuarter(db, { property: propertyId, ...q });
      throw new AppError(409, `${label} is already marked paid. Clear it first to record a different payment.`, {
        current: existing,
      });
    }
    const linked = i.transaction_id != null ? linkableExpense(db, propertyId, i.transaction_id) : null;
    const paidDate = i.paid_date ?? linked?.date;
    const amountCents = i.amount_paid != null ? cents(i.amount_paid) : linked ? -cents(linked.amount) : null;
    if (!paidDate) throw badRequest("paid_date is required");
    if (amountCents == null || amountCents <= 0) throw badRequest("amount_paid is required (dollars, positive)");
    if (paidDate < quarterRange(q).start)
      throw badRequest(`The ${label} return can't be paid before the quarter starts`);

    const report = buildQuarter(db, propertyId, q, todayIso(), inputsFor(db, propertyId));
    // Without a gross from the caller, use the computed one only when every month's statement is saved; an
    // incomplete (often $0, for quarters paid before statements were saved) gross is left "not recorded".
    const computed = report.complete ? cents(report.gross) : null;
    const grossCents = i.gross_filed !== undefined ? (i.gross_filed == null ? null : cents(i.gross_filed)) : computed;

    let transactionId: number;
    if (linked) {
      transactionId = linked.id;
      if (i.upload_ids?.length) claimUploads(db, actor, linked.id, i.upload_ids);
    } else {
      const category = resolveCategory(db, STATE_TAX_CATEGORY);
      if (category.kind !== "expense")
        throw badRequest(`The "${STATE_TAX_CATEGORY}" category isn't an expense category`);
      const created: Transaction = createTransaction(db, actor, {
        property_id: propertyId,
        date: paidDate,
        amount: -amountCents / 100,
        category_id: category.id,
        subcategory: "",
        allocation: "direct",
        description: `State sales tax ${label}${grossCents != null ? ` (gross ${usd(grossCents)})` : ""}`,
        reference: i.confirmation,
        upload_ids: i.upload_ids,
      });
      transactionId = created.id;
    }

    const userId = actor.user.id;
    const { id } = db
      .insert(stateTaxFilings)
      .values({
        propertyId,
        year: q.year,
        quarter: q.quarter,
        grossFiledCents: grossCents,
        amountPaidCents: amountCents,
        paidDate,
        confirmation: i.confirmation,
        transactionId,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: stateTaxFilings.id })
      .get();
    audit(db, actor, "create", "state_tax_filing", id, {
      property_id: propertyId,
      quarter: label,
      gross_filed: grossCents == null ? null : grossCents / 100,
      amount_paid: amountCents / 100,
      paid_date: paidDate,
      confirmation: i.confirmation,
      transaction_id: transactionId,
      linked_existing: !!linked,
    });
    return stateTaxQuarter(db, { property: propertyId, ...q });
  });
}

/** An expense that may be linked as a quarter's payment: this property's, live, an expense, not already linked. */
function linkableExpense(db: DB, propertyId: number, id: number) {
  const t = db
    .select({
      id: transactions.id,
      propertyId: transactions.propertyId,
      date: transactions.date,
      amount: sql<number>`${transactions.amountCents} / 100.0`,
      deletedAt: transactions.deletedAt,
      kind: categories.kind,
      category: categories.name,
    })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(eq(transactions.id, id))
    .get();
  if (!t || t.deletedAt) throw badRequest(`Transaction ${id} not found`);
  if (t.propertyId !== propertyId) throw badRequest(`Transaction ${id} belongs to another property`);
  if (t.kind !== "expense" || t.amount >= 0) throw badRequest(`Transaction ${id} isn't an expense`);
  const other = db
    .select({ year: stateTaxFilings.year, quarter: stateTaxFilings.quarter })
    .from(stateTaxFilings)
    .where(eq(stateTaxFilings.transactionId, id))
    .get();
  if (other) throw badRequest(`Transaction ${id} is already the payment for ${quarterLabel(other)}`);
  return t;
}

/** Undo "paid": removes the filing. The linked expense stays unless trash_expense (then it goes to the trash). */
export function clearStateTaxPaid(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const i = clearInput.parse(raw);
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  const q = { year: i.year, quarter: i.quarter };
  return tx(db, () => {
    const f = findFiling(db, propertyId, q);
    if (!f) throw badRequest(`${quarterLabel(q)} isn't marked paid`);
    db.delete(stateTaxFilings).where(eq(stateTaxFilings.id, f.id)).run();
    let trashed: number | null = null;
    if (i.trash_expense && f.transaction_id != null) {
      const live = db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.id, f.transaction_id), isNull(transactions.deletedAt)))
        .get();
      if (live) {
        deleteTransaction(db, actor, live.id);
        trashed = live.id;
      }
    }
    audit(db, actor, "delete", "state_tax_filing", f.id, { ...f, quarter: quarterLabel(q), trashed_expense: trashed });
    return {
      cleared: true,
      /** the expense that recorded the payment: still in the ledger unless trashed */
      transaction_id: f.transaction_id,
      expense_trashed: trashed != null,
      quarter: stateTaxQuarter(db, { property: propertyId, ...q }),
    };
  });
}

/** Set the Location ID shown on the quarter report (and that turns on To do reminders). */
export function setLocationId(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const i = z
    .object({ property: ref.optional(), property_id: ref.optional(), location_id: z.string().trim().max(50) })
    .parse(raw);
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  const before = getProperty(db, propertyId).state_tax_location_id;
  db.update(properties).set({ stateTaxLocationId: i.location_id }).where(eq(properties.id, propertyId)).run();
  audit(db, actor, "update", "property", propertyId, { state_tax_location_id: [before, i.location_id] });
  return propertyHeader(db, propertyId);
}

// ======================= To do =======================

function remindersOn(db: DB, propertyId: number) {
  const p = getProperty(db, propertyId);
  if (p.archived) return false;
  if (p.state_tax_location_id) return true;
  return !!db
    .select({ id: stateTaxFilings.id })
    .from(stateTaxFilings)
    .where(eq(stateTaxFilings.propertyId, propertyId))
    .get();
}

export interface StateTaxDue {
  property_id: number;
  property: string;
  year: number;
  quarter: number;
  label: string;
  due_date: string;
  days_left: number;
  status: "open" | "overdue";
  gross: number;
  complete: boolean;
  location_id: string;
}

/**
 * Unpaid quarters to show on the To do list: ended, and due within REMIND_DAYS or already overdue. Only properties
 * with a Location ID (or a payment on record), and overdue quarters only back to the property's first saved statement
 * or payment, at most OVERDUE_LOOKBACK_QUARTERS back, so a new ledger isn't flooded with years of reminders.
 */
export function stateTaxAttention(db: DB, opts: { propertyId?: number; today?: string } = {}): StateTaxDue[] {
  const today = opts.today ?? todayIso();
  const ids = opts.propertyId
    ? [opts.propertyId]
    : db
        .select({ id: properties.id })
        .from(properties)
        .where(eq(properties.archived, false))
        .all()
        .map((r) => r.id);
  const out: StateTaxDue[] = [];
  for (const propertyId of ids) {
    if (!remindersOn(db, propertyId)) continue;
    const firstDoc = db
      .select({ m: sql<string | null>`min(${managerDocuments.month})` })
      .from(managerDocuments)
      .where(and(eq(managerDocuments.propertyId, propertyId), eq(managerDocuments.kind, "statement")))
      .get()?.m;
    const firstFiling = db
      .select({ y: stateTaxFilings.year, q: stateTaxFilings.quarter })
      .from(stateTaxFilings)
      .where(eq(stateTaxFilings.propertyId, propertyId))
      .orderBy(stateTaxFilings.year, stateTaxFilings.quarter)
      .get();
    const starts = [
      firstDoc ? quarterOf(`${firstDoc}-01`) : null,
      firstFiling ? { year: firstFiling.y, quarter: firstFiling.q } : null,
    ]
      .filter((x): x is QuarterRef => x != null)
      .map((x) => x.year * 4 + x.quarter);
    // the last quarter that has ended
    let q = prevQuarter(quarterOf(today));
    const earliest = starts.length ? Math.min(...starts) : q.year * 4 + q.quarter;
    let inputs: QuarterInputs | null = null;
    const p = getProperty(db, propertyId);
    for (let n = 0; n < OVERDUE_LOOKBACK_QUARTERS && q.year * 4 + q.quarter >= earliest; n++, q = prevQuarter(q)) {
      const due = dueDate(q);
      const daysLeft = dayNumber(due) - dayNumber(today);
      if (daysLeft > REMIND_DAYS) continue;
      if (findFiling(db, propertyId, q)) continue;
      inputs ??= inputsFor(db, propertyId);
      const r = buildQuarter(db, propertyId, q, today, inputs);
      out.push({
        property_id: propertyId,
        property: p.name,
        year: q.year,
        quarter: q.quarter,
        label: r.label,
        due_date: due,
        days_left: daysLeft,
        status: daysLeft < 0 ? "overdue" : "open",
        gross: r.gross,
        complete: r.complete,
        location_id: p.state_tax_location_id,
      });
    }
  }
  return out.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.property.localeCompare(b.property));
}

// ======================= preparer package =======================

/** One line per quarter of the year, for Summary.txt. */
export function stateTaxSummaryLines(db: DB, propertyId: number, year: number, today = todayIso()) {
  const y = stateTaxYear(db, { property: propertyId, year, today });
  const any = y.quarters.some((q) => q.filing || q.gross || q.reservations.length);
  if (!any && !y.reminders) return [];
  const L = [
    `STATE SALES TAX (quarterly returns${y.property.location_id ? `, Location ID ${y.property.location_id}` : ""})`,
  ];
  for (const q of y.quarters) {
    const f = q.filing;
    const left = `  Q${q.quarter} (due ${q.due_date})`.padEnd(24);
    if (f)
      L.push(
        `${left} gross filed ${f.gross_filed != null ? usd(Math.round(f.gross_filed * 100)) : "not recorded"}, paid ${usd(Math.round(f.amount_paid * 100))} on ${f.paid_date}${f.confirmation ? ` (confirmation ${f.confirmation})` : ""}`,
      );
    else
      L.push(
        `${left} ${q.status === "in_progress" ? "quarter not over" : "not paid"}; gross from manager statements ${usd(Math.round(q.gross * 100))}`,
      );
  }
  L.push("  The payments are in the ledger as Taxes (direct).", "");
  return L;
}
