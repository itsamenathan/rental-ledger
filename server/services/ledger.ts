import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { AnyColumn } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import {
  attachments,
  categories,
  properties,
  subcategories as subcategoriesTable,
  transactions,
  users,
} from "../db/schema.ts";
import {
  audit,
  badRequest,
  cents,
  diff,
  dollars,
  notFound,
  requireAdmin,
  requireWrite,
  type Actor,
} from "../context.ts";

// ======================= shared schema bits =======================

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s + "T00:00:00Z")), "Invalid date");
const money = z
  .number()
  .finite()
  .refine((n) => Math.abs(n) < 1e9, "Amount too large");
const allocation = z.enum(["direct", "indirect"]).nullable();

// ======================= properties =======================

export const propertyInput = z.object({
  name: z.string().trim().min(1).max(100),
  address: z.string().trim().max(300).default(""),
  placed_in_service: isoDate.nullable().default(null),
  building_basis: money.nullable().default(null),
  recovery_years: z.number().positive().max(60).default(27.5),
  notes: z.string().max(5000).default(""),
  archived: z.boolean().default(false),
});

type PropertyRow = typeof properties.$inferSelect;

const toProperty = (r: PropertyRow) => ({
  id: r.id,
  name: r.name,
  address: r.address,
  placed_in_service: r.placedInService,
  building_basis: dollars(r.buildingBasisCents),
  recovery_years: r.recoveryYears,
  notes: r.notes,
  archived: r.archived,
});
export type Property = ReturnType<typeof toProperty>;

const propertyValues = (p: Partial<z.infer<typeof propertyInput>>) => ({
  name: p.name,
  address: p.address,
  placedInService: p.placed_in_service,
  buildingBasisCents:
    p.building_basis === undefined ? undefined : p.building_basis == null ? null : cents(p.building_basis),
  recoveryYears: p.recovery_years,
  notes: p.notes,
  archived: p.archived,
});

const byName = (col: typeof properties.name | typeof categories.name, name: string) =>
  eq(sql`lower(${col})`, name.trim().toLowerCase());

export function listProperties(db: DB) {
  return db.select().from(properties).orderBy(properties.archived, properties.name).all().map(toProperty);
}

export function getProperty(db: DB, id: number) {
  const r = db.select().from(properties).where(eq(properties.id, id)).get();
  if (!r) throw notFound("Property");
  return toProperty(r);
}

export function createProperty(db: DB, actor: Actor | null, raw: unknown) {
  if (actor) requireWrite(actor);
  const p = propertyInput.parse(raw);
  if (db.select({ id: properties.id }).from(properties).where(byName(properties.name, p.name)).get())
    throw badRequest("A property with that name already exists");
  const { id } = db
    .insert(properties)
    .values({ ...propertyValues(p), name: p.name })
    .returning({ id: properties.id })
    .get();
  audit(db, actor, "create", "property", id, p);
  return getProperty(db, id);
}

export function updateProperty(db: DB, actor: Actor, id: number, raw: unknown) {
  requireWrite(actor);
  const before = getProperty(db, id);
  const p = propertyInput.partial().parse(raw);
  if (Object.keys(p).length) db.update(properties).set(propertyValues(p)).where(eq(properties.id, id)).run();
  const after = getProperty(db, id);
  audit(db, actor, "update", "property", id, diff(before, after));
  return after;
}

/** Accepts a numeric id or a (case-insensitive) property name. Defaults to the sole active property. */
export function resolvePropertyId(db: DB, ref: number | string | null | undefined): number {
  if (ref == null || ref === "") {
    const rows = db
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.archived, false))
      .orderBy(properties.id)
      .all();
    if (rows.length === 1) return rows[0]!.id;
    if (rows.length === 0) throw badRequest("No properties exist yet; create one first");
    throw badRequest("Multiple properties exist; specify property (name or id)");
  }
  const row = db
    .select({ id: properties.id })
    .from(properties)
    .where(typeof ref === "number" || /^\d+$/.test(ref) ? eq(properties.id, Number(ref)) : byName(properties.name, ref))
    .get();
  if (!row) throw badRequest(`Unknown property: ${ref}`);
  return row.id;
}

// ======================= categories =======================

/** IRS Schedule E (Form 1040) expense lines. */
export const SCHEDULE_E_LINES: Record<string, string> = {
  "3": "Rents received",
  "4": "Royalties received",
  "5": "Advertising",
  "6": "Auto and travel",
  "7": "Cleaning and maintenance",
  "8": "Commissions",
  "9": "Insurance",
  "10": "Legal and other professional fees",
  "11": "Management fees",
  "12": "Mortgage interest paid to banks",
  "13": "Other interest",
  "14": "Repairs",
  "15": "Supplies",
  "16": "Taxes",
  "17": "Utilities",
  "18": "Depreciation expense or depletion",
  "19": "Other",
};

export const categoryInput = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["income", "expense"]),
  default_allocation: allocation.default(null),
  schedule_e_line: z
    .enum(Object.keys(SCHEDULE_E_LINES) as [string, ...string[]])
    .nullable()
    .default(null),
  description: z.string().max(1000).default(""),
  sort_order: z.number().int().default(0),
  archived: z.boolean().default(false),
});

export interface Category {
  id: number;
  name: string;
  kind: "income" | "expense";
  default_allocation: "direct" | "indirect" | null;
  schedule_e_line: string | null;
  description: string;
  sort_order: number;
  archived: boolean;
}

const categoryCols = {
  id: categories.id,
  name: categories.name,
  kind: categories.kind,
  default_allocation: categories.defaultAllocation,
  schedule_e_line: categories.scheduleELine,
  description: categories.description,
  sort_order: categories.sortOrder,
  archived: categories.archived,
};

const categoryValues = (c: Partial<z.infer<typeof categoryInput>>) => ({
  name: c.name,
  kind: c.kind,
  defaultAllocation: c.default_allocation,
  scheduleELine: c.schedule_e_line,
  description: c.description,
  sortOrder: c.sort_order,
  archived: c.archived,
});

export function listCategories(db: DB, includeArchived = true): Category[] {
  return db
    .select(categoryCols)
    .from(categories)
    .where(includeArchived ? undefined : eq(categories.archived, false))
    .orderBy(desc(categories.kind), categories.sortOrder, categories.name)
    .all();
}

export function getCategory(db: DB, id: number): Category {
  const r = db.select(categoryCols).from(categories).where(eq(categories.id, id)).get();
  if (!r) throw notFound("Category");
  return r;
}

export function createCategory(db: DB, actor: Actor | null, raw: unknown) {
  if (actor) requireWrite(actor);
  const c = categoryInput.parse(raw);
  if (db.select({ id: categories.id }).from(categories).where(byName(categories.name, c.name)).get())
    throw badRequest("Category already exists");
  const { id } = db
    .insert(categories)
    .values({ ...categoryValues(c), name: c.name, kind: c.kind })
    .returning({ id: categories.id })
    .get();
  audit(db, actor, "create", "category", id, c);
  return getCategory(db, id);
}

function usageCount(db: DB, categoryId: number, includeDeleted: boolean) {
  return db
    .select({ n: count() })
    .from(transactions)
    .where(and(eq(transactions.categoryId, categoryId), includeDeleted ? undefined : isNull(transactions.deletedAt)))
    .get()!.n;
}

export function updateCategory(db: DB, actor: Actor, id: number, raw: unknown) {
  requireWrite(actor);
  const before = getCategory(db, id);
  const c = categoryInput.partial().parse(raw);
  if (c.kind && c.kind !== before.kind && usageCount(db, id, false)) {
    throw badRequest("Cannot change income/expense kind of a category that has transactions");
  }
  if (Object.keys(c).length) db.update(categories).set(categoryValues(c)).where(eq(categories.id, id)).run();
  const after = getCategory(db, id);
  audit(db, actor, "update", "category", id, diff(before as never, after as never));
  return after;
}

export function deleteCategory(db: DB, actor: Actor, id: number) {
  requireAdmin(actor);
  if (usageCount(db, id, true)) throw badRequest("Category has transactions; archive it instead");
  const before = getCategory(db, id);
  db.delete(categories).where(eq(categories.id, id)).run();
  audit(db, actor, "delete", "category", id, before);
}

export function resolveCategory(db: DB, ref: number | string): Category {
  const row = db
    .select(categoryCols)
    .from(categories)
    .where(typeof ref === "number" || /^\d+$/.test(ref) ? eq(categories.id, Number(ref)) : byName(categories.name, ref))
    .get();
  if (!row) {
    const names = listCategories(db, false)
      .map((c) => c.name)
      .join(", ");
    throw badRequest(`Unknown category "${ref}". Valid categories: ${names}`);
  }
  return row;
}

// ======================= transactions =======================

const txFields = {
  property: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("Property id or name; defaults to the only property"),
  property_id: z.number().int().optional(),
  date: isoDate.describe("Date paid/received, YYYY-MM-DD"),
  amount: money.describe("Signed dollars: income positive, expenses negative"),
  category: z.union([z.number().int(), z.string()]).optional().describe("Category name or id"),
  category_id: z.number().int().optional(),
  subcategory: z.string().trim().max(100).default(""),
  vendor: z.string().trim().max(200).default(""),
  allocation: allocation.optional().describe("direct | indirect (expenses). Defaults from category"),
  description: z.string().max(2000).default(""),
  account: z.string().trim().max(100).default("").describe("Payment account, e.g. 'Checking', 'Amex'"),
  reference: z.string().max(500).default("").describe("Bank memo / external reference, used for de-duplication"),
  needs_review: z.boolean().default(false),
  review_note: z.string().max(2000).default(""),
  external_id: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("Stable id from the source system; duplicates are rejected"),
  refund: z
    .boolean()
    .default(false)
    .describe("Set true when the sign intentionally differs from the category kind (refund/reimbursement)"),
};

export const transactionInput = z.object(txFields).refine((t) => t.category != null || t.category_id != null, {
  message: "category (name or id) is required",
  path: ["category"],
});

export const transactionPatch = z.object({
  property: txFields.property,
  property_id: txFields.property_id,
  date: isoDate.optional(),
  amount: money.optional(),
  category: txFields.category,
  category_id: txFields.category_id,
  subcategory: z.string().trim().max(100).optional(),
  vendor: z.string().trim().max(200).optional(),
  allocation: allocation.optional(),
  description: z.string().max(2000).optional(),
  account: z.string().trim().max(100).optional(),
  reference: z.string().max(500).optional(),
  needs_review: z.boolean().optional(),
  review_note: z.string().max(2000).optional(),
  refund: z.boolean().default(false),
});

const createdByUser = alias(users, "created_by_user");
const updatedByUser = alias(users, "updated_by_user");
const attachmentCount = sql<number>`(SELECT count(*) FROM ${attachments} WHERE ${attachments.transactionId} = ${transactions.id})`;

/** Joined transaction row in the API's (snake_case) shape. */
function selectTx(db: DB) {
  return db
    .select({
      id: transactions.id,
      property_id: transactions.propertyId,
      property: properties.name,
      date: transactions.date,
      amount: sql<number>`${transactions.amountCents} / 100.0`,
      category_id: transactions.categoryId,
      category: categories.name,
      kind: categories.kind,
      schedule_e_line: categories.scheduleELine,
      subcategory: transactions.subcategory,
      vendor: transactions.vendor,
      allocation: transactions.allocation,
      description: transactions.description,
      account: transactions.account,
      reference: transactions.reference,
      needs_review: transactions.needsReview,
      review_note: transactions.reviewNote,
      source: transactions.source,
      external_id: transactions.externalId,
      attachment_count: attachmentCount,
      created_at: transactions.createdAt,
      created_by: createdByUser.email,
      updated_at: transactions.updatedAt,
      updated_by: updatedByUser.email,
    })
    .from(transactions)
    .innerJoin(properties, eq(properties.id, transactions.propertyId))
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(createdByUser, eq(createdByUser.id, transactions.createdBy))
    .leftJoin(updatedByUser, eq(updatedByUser.id, transactions.updatedBy));
}
export type Transaction = NonNullable<ReturnType<ReturnType<typeof selectTx>["get"]>>;

export function getTransaction(db: DB, id: number): Transaction {
  const r = selectTx(db)
    .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
    .get();
  if (!r) throw notFound(`Transaction ${id}`);
  return r;
}

export const transactionQuery = z.object({
  year: z.coerce.number().int().optional(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  property_id: z.coerce.number().int().optional(),
  category: z.union([z.coerce.number().int(), z.string()]).optional(),
  kind: z.enum(["income", "expense"]).optional(),
  allocation: z.enum(["direct", "indirect", "none"]).optional(),
  vendor: z.string().optional(),
  q: z.string().optional().describe("Search description, vendor, subcategory, reference"),
  needs_review: z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean()).optional(),
  has_attachment: z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean()).optional(),
  amount: z
    .string()
    .optional()
    .describe('Amount search (sign ignored): "69.95" exact, "70" = 70.00–70.99, "50-100", ">500", "<20", "~70" (±10%)'),
  min_amount: z.coerce.number().optional().describe("Minimum absolute amount"),
  max_amount: z.coerce.number().optional().describe("Maximum absolute amount"),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc", "updated_desc"]).default("date_desc"),
  limit: z.coerce.number().int().min(1).max(5000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TransactionQuery = z.infer<typeof transactionQuery>;

const t = transactions;

/** Parse an amount search into an inclusive [min, max] range of absolute cents. */
export function parseAmountSearch(raw: string): { min?: number; max?: number } | null {
  const s = raw.replace(/[$,\s]/g, "");
  const num = "(\\d+(?:\\.\\d{1,2})?|\\.\\d{1,2})";
  let m: RegExpMatchArray | null;
  const c = (x: string) => cents(Number(x));
  if ((m = s.match(new RegExp(`^${num}(?:-|\\.\\.|to)${num}$`, "i")))) {
    const [a, b] = [c(m[1]!), c(m[2]!)].sort((x, y) => x - y);
    return { min: a, max: b };
  }
  if ((m = s.match(new RegExp(`^(>=?|<=?)${num}$`)))) {
    const v = c(m[2]!);
    if (m[1] === ">") return { min: v + 1 };
    if (m[1] === ">=") return { min: v };
    if (m[1] === "<") return { max: v - 1 };
    return { max: v };
  }
  if ((m = s.match(new RegExp(`^~${num}$`)))) {
    const v = c(m[1]!);
    return { min: Math.floor(v * 0.9), max: Math.ceil(v * 1.1) };
  }
  if ((m = s.match(new RegExp(`^${num}$`)))) {
    const v = c(m[1]!);
    return m[1]!.includes(".") ? { min: v, max: v } : { min: v, max: v + 99 };
  }
  return null;
}

const absAmountIn = (r: { min?: number; max?: number }) =>
  and(
    r.min != null ? gte(sql`abs(${t.amountCents})`, r.min) : undefined,
    r.max != null ? lte(sql`abs(${t.amountCents})`, r.max) : undefined,
  );

function transactionFilters(db: DB, q: TransactionQuery): SQL | undefined {
  const where: (SQL | undefined)[] = [isNull(t.deletedAt)];
  if (q.year) where.push(gte(t.date, `${q.year}-01-01`), lte(t.date, `${q.year}-12-31`));
  if (q.month) where.push(eq(sql`substr(${t.date}, 1, 7)`, q.month));
  if (q.from) where.push(gte(t.date, q.from));
  if (q.to) where.push(lte(t.date, q.to));
  if (q.property_id) where.push(eq(t.propertyId, q.property_id));
  if (q.category != null && q.category !== "") where.push(eq(t.categoryId, resolveCategory(db, q.category).id));
  if (q.kind) where.push(eq(categories.kind, q.kind));
  if (q.allocation === "none") where.push(isNull(t.allocation));
  else if (q.allocation) where.push(eq(t.allocation, q.allocation));
  if (q.vendor) where.push(eq(sql`lower(${t.vendor})`, q.vendor.toLowerCase()));
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    // "$42", "42.50", "1,200" in the search box also match amounts
    const asAmount = /^\$?[\d,]*\.?\d+$/.test(q.q.trim()) ? parseAmountSearch(q.q) : null;
    const m = (col: AnyColumn) => sql`${col} LIKE ${like} ESCAPE '\\'`;
    where.push(
      or(
        m(t.description),
        m(t.vendor),
        m(t.subcategory),
        m(t.reference),
        m(categories.name),
        eq(sql`CAST(${t.id} AS TEXT)`, q.q),
        asAmount ? absAmountIn(asAmount) : undefined,
      ),
    );
  }
  if (q.needs_review != null) where.push(eq(t.needsReview, q.needs_review));
  if (q.has_attachment != null) {
    const has = exists(
      db
        .select({ x: sql`1` })
        .from(attachments)
        .where(eq(attachments.transactionId, t.id)),
    );
    where.push(q.has_attachment ? has : not(has));
  }
  if (q.amount) {
    const r = parseAmountSearch(q.amount);
    if (!r) throw badRequest("Amount search: use 69.95, 50-100, >500, <20 or ~70");
    where.push(absAmountIn(r));
  }
  if (q.min_amount != null) where.push(gte(sql`abs(${t.amountCents})`, cents(q.min_amount)));
  if (q.max_amount != null) where.push(lte(sql`abs(${t.amountCents})`, cents(q.max_amount)));
  return and(...where);
}

export function listTransactions(db: DB, raw: unknown) {
  const q = transactionQuery.parse(raw);
  const where = transactionFilters(db, q);
  const order = {
    date_desc: [desc(t.date), desc(t.id)],
    date_asc: [asc(t.date), asc(t.id)],
    amount_desc: [desc(t.amountCents)],
    amount_asc: [asc(t.amountCents)],
    updated_desc: [desc(t.updatedAt)],
  }[q.sort];
  const agg = db
    .select({
      total: count(),
      net: sql<number>`coalesce(sum(${t.amountCents}), 0)`,
      income: sql<number>`coalesce(sum(CASE WHEN ${categories.kind} = 'income' THEN ${t.amountCents} END), 0)`,
      expense: sql<number>`coalesce(sum(CASE WHEN ${categories.kind} = 'expense' THEN ${t.amountCents} END), 0)`,
    })
    .from(t)
    .innerJoin(categories, eq(categories.id, t.categoryId))
    .where(where)
    .get()!;
  const items = selectTx(db)
    .where(where)
    .orderBy(...order)
    .limit(q.limit)
    .offset(q.offset)
    .all();
  return {
    items,
    total: agg.total,
    totals: { net: agg.net / 100, income: agg.income / 100, expense: agg.expense / 100 },
    limit: q.limit,
    offset: q.offset,
  };
}

function checkSign(category: Category, amountCents: number, refund: boolean) {
  if (amountCents === 0 || refund) return;
  const expected = category.kind === "income" ? 1 : -1;
  if (Math.sign(amountCents) !== expected) {
    throw badRequest(
      category.kind === "expense"
        ? `Expenses are stored as negative amounts (got ${amountCents / 100} for "${category.name}"). Use a negative amount, or set refund=true if this is money returned to you.`
        : `Income is stored as a positive amount (got ${amountCents / 100} for "${category.name}"). Use a positive amount, or set refund=true for a reversal/chargeback.`,
    );
  }
}

export interface CreateOptions {
  source?: string;
  /** Skip the income/expense sign check (trusted imports). */
  trustSign?: boolean;
}

/** Normalize and validate a create payload into a DB row. */
function prepareRow(db: DB, raw: unknown, opts: CreateOptions) {
  const v = transactionInput.parse(raw);
  const category = resolveCategory(db, (v.category_id ?? v.category)!);
  const amountCents = cents(v.amount);
  if (!opts.trustSign) checkSign(category, amountCents, v.refund);
  const alloc =
    v.allocation !== undefined ? v.allocation : category.kind === "expense" ? category.default_allocation : null;
  return {
    propertyId: resolvePropertyId(db, v.property_id ?? v.property),
    date: v.date,
    amountCents,
    categoryId: category.id,
    subcategory: v.subcategory,
    vendor: v.vendor,
    allocation: category.kind === "income" ? null : alloc,
    description: v.description,
    account: v.account,
    reference: v.reference,
    needsReview: v.needs_review,
    reviewNote: v.review_note,
    externalId: v.external_id ?? null,
  } satisfies Partial<typeof transactions.$inferInsert>;
}
type PreparedRow = ReturnType<typeof prepareRow>;

function insertRow(db: DB, actor: Actor | null, row: PreparedRow, source: string): number {
  const userId = actor?.user.id ?? null;
  return db
    .insert(transactions)
    .values({ ...row, source, createdBy: userId, updatedBy: userId })
    .returning({ id: transactions.id })
    .get().id;
}

const nowIso = sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export function createTransaction(db: DB, actor: Actor | null, raw: unknown, opts: CreateOptions = {}): Transaction {
  if (actor) requireWrite(actor);
  const row = prepareRow(db, raw, opts);
  if (row.externalId && db.select({ id: t.id }).from(t).where(eq(t.externalId, row.externalId)).get()) {
    throw badRequest(`A transaction with external_id ${row.externalId} already exists`);
  }
  return tx(db, () => {
    const id = insertRow(db, actor, row, opts.source ?? actor?.via ?? "cli");
    const created = getTransaction(db, id);
    audit(db, actor, "create", "transaction", id, created);
    return created;
  });
}

export function updateTransaction(db: DB, actor: Actor, id: number, raw: unknown): Transaction {
  requireWrite(actor);
  const p = transactionPatch.parse(raw);
  const before = getTransaction(db, id);
  const category =
    p.category_id != null || p.category != null
      ? resolveCategory(db, (p.category_id ?? p.category)!)
      : getCategory(db, before.category_id);
  const beforeCents = Math.round(before.amount * 100);
  const amountCents = p.amount != null ? cents(p.amount) : beforeCents;
  // Only re-check the sign when it could have become wrong; existing refunds can be re-categorized freely.
  if (amountCents !== beforeCents || category.kind !== before.kind) {
    checkSign(category, amountCents, p.refund);
  }
  let alloc = p.allocation !== undefined ? p.allocation : before.allocation;
  if (category.kind === "income") alloc = null;
  else if (category.id !== before.category_id && p.allocation === undefined && alloc == null)
    alloc = category.default_allocation;

  return tx(db, () => {
    db.update(t)
      .set({
        propertyId:
          p.property_id != null || p.property != null ? resolvePropertyId(db, p.property_id ?? p.property) : undefined,
        date: p.date,
        amountCents,
        categoryId: category.id,
        subcategory: p.subcategory,
        vendor: p.vendor,
        allocation: alloc,
        description: p.description,
        account: p.account,
        reference: p.reference,
        needsReview: p.needs_review,
        reviewNote: p.review_note ?? (p.needs_review === false ? "" : undefined),
        updatedBy: actor.user.id,
        updatedAt: nowIso,
      })
      .where(eq(t.id, id))
      .run();
    const after = getTransaction(db, id);
    const { updated_at: _a, updated_by: _b, ...b } = before;
    const { updated_at: _c, updated_by: _d, ...a } = after;
    audit(db, actor, "update", "transaction", id, diff(b, a));
    return after;
  });
}

export function deleteTransaction(db: DB, actor: Actor, id: number) {
  requireWrite(actor);
  const before = getTransaction(db, id);
  db.update(t).set({ deletedAt: nowIso, updatedBy: actor.user.id }).where(eq(t.id, id)).run();
  audit(db, actor, "delete", "transaction", id, before);
  return { id, deleted: true };
}

export function restoreTransaction(db: DB, actor: Actor, id: number) {
  requireWrite(actor);
  const r = db
    .update(t)
    .set({ deletedAt: null, updatedBy: actor.user.id })
    .where(and(eq(t.id, id), isNotNull(t.deletedAt)))
    .run();
  if (!r.changes) throw notFound(`Deleted transaction ${id}`);
  audit(db, actor, "restore", "transaction", id);
  return getTransaction(db, id);
}

// ---------- bulk ----------

export const bulkInput = z.object({
  transactions: z.array(z.unknown()).min(1).max(5000),
  dry_run: z.boolean().default(false),
  skip_duplicates: z.boolean().default(true).describe("Skip rows that look like existing transactions"),
  needs_review: z.boolean().optional().describe("Force needs_review on every row (e.g. for agent-categorized imports)"),
});

export interface BulkRowResult {
  index: number;
  status: "created" | "would_create" | "duplicate" | "error";
  id?: number;
  duplicate_of?: number[];
  error?: string;
}

/** Find likely duplicates: same external_id, or same property+date+amount (and same reference when both have one). */
function findDuplicates(db: DB, row: PreparedRow): number[] {
  if (row.externalId) {
    const r = db.select({ id: t.id }).from(t).where(eq(t.externalId, row.externalId)).get();
    if (r) return [r.id];
  }
  return db
    .select({ id: t.id, reference: t.reference })
    .from(t)
    .where(
      and(
        isNull(t.deletedAt),
        eq(t.propertyId, row.propertyId),
        eq(t.date, row.date),
        eq(t.amountCents, row.amountCents),
      ),
    )
    .all()
    .filter((r) => !row.reference || !r.reference || r.reference === row.reference)
    .map((r) => r.id);
}

export function bulkCreate(db: DB, actor: Actor | null, raw: unknown, opts: CreateOptions = {}) {
  if (actor) requireWrite(actor);
  const input = bulkInput.parse(raw);
  const results: BulkRowResult[] = [];
  const seen: PreparedRow[] = [];
  const run = () => {
    input.transactions.forEach((item, index) => {
      try {
        const obj = { ...(item as object) } as Record<string, unknown>;
        if (input.needs_review != null) obj.needs_review = input.needs_review;
        const row = prepareRow(db, obj, opts);
        const dupes = findDuplicates(db, row);
        // duplicates within this same batch
        const inBatch = seen.some(
          (s) =>
            s.date === row.date &&
            s.amountCents === row.amountCents &&
            s.propertyId === row.propertyId &&
            (!s.reference || !row.reference || s.reference === row.reference) &&
            (s.externalId == null || row.externalId == null || s.externalId === row.externalId),
        );
        if ((dupes.length && input.skip_duplicates) || (row.externalId && dupes.length)) {
          results.push({ index, status: "duplicate", duplicate_of: dupes });
          return;
        }
        if (inBatch && input.skip_duplicates && !row.externalId) {
          results.push({
            index,
            status: "duplicate",
            duplicate_of: [],
            error: "Duplicate of an earlier row in this batch",
          });
          return;
        }
        seen.push(row);
        if (input.dry_run) {
          results.push({ index, status: "would_create", duplicate_of: dupes.length ? dupes : undefined });
          return;
        }
        const id = insertRow(db, actor, row, opts.source ?? actor?.via ?? "cli");
        results.push({ index, status: "created", id, duplicate_of: dupes.length ? dupes : undefined });
      } catch (e) {
        const msg = e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message;
        results.push({ index, status: "error", error: msg });
      }
    });
  };
  if (input.dry_run) run();
  else
    tx(db, () => {
      run();
      const created = results.filter((r) => r.status === "created").map((r) => r.id);
      if (created.length) audit(db, actor, "bulk_create", "transaction", null, { ids: created });
    });
  const count = (s: BulkRowResult["status"]) => results.filter((r) => r.status === s).length;
  return {
    dry_run: input.dry_run,
    created: count("created"),
    would_create: count("would_create"),
    duplicates: count("duplicate"),
    errors: count("error"),
    results,
  };
}

export const bulkUpdateInput = z.object({
  ids: z.array(z.number().int()).min(1).max(5000),
  patch: transactionPatch,
});

export function bulkUpdate(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const { ids, patch } = bulkUpdateInput.parse(raw);
  return tx(db, () => ({ updated: ids.map((id) => updateTransaction(db, actor, id, patch).id) }));
}

export function bulkDelete(db: DB, actor: Actor, ids: number[]) {
  requireWrite(actor);
  return tx(db, () => ({ deleted: ids.map((id) => deleteTransaction(db, actor, id).id) }));
}

// ---------- autocomplete ----------

/** Vendors with their most recent categorization, to auto-fill quick entry. */
export function suggestions(db: DB) {
  const live = and(isNull(t.deletedAt), ne(t.vendor, ""));
  const latest = db
    .select({
      vendor: t.vendor,
      category: categories.name,
      subcategory: t.subcategory,
      allocation: t.allocation,
      // row_number picks the most recent transaction per vendor
      rn: sql<number>`row_number() OVER (PARTITION BY lower(${t.vendor}) ORDER BY ${t.date} DESC, ${t.id} DESC)`.as(
        "rn",
      ),
      uses: sql<number>`count(*) OVER (PARTITION BY lower(${t.vendor}))`.as("uses"),
    })
    .from(t)
    .innerJoin(categories, eq(categories.id, t.categoryId))
    .where(live)
    .as("latest");
  const vendors = db
    .select({
      vendor: latest.vendor,
      category: latest.category,
      subcategory: latest.subcategory,
      allocation: latest.allocation,
      uses: latest.uses,
    })
    .from(latest)
    .where(eq(latest.rn, 1))
    .orderBy(desc(latest.uses), latest.vendor)
    .all();
  const subcategories = db
    .select({ category: categories.name, subcategory: t.subcategory, uses: count() })
    .from(t)
    .innerJoin(categories, eq(categories.id, t.categoryId))
    .where(and(isNull(t.deletedAt), ne(t.subcategory, "")))
    .groupBy(categories.name, t.subcategory)
    .orderBy(desc(count()))
    .all();
  const accounts = db
    .select({ account: t.account, uses: count() })
    .from(t)
    .where(and(isNull(t.deletedAt), ne(t.account, "")))
    .groupBy(t.account)
    .orderBy(desc(count()))
    .all();
  const categoryUse = db
    .select({ category_id: t.categoryId, uses: count() })
    .from(t)
    .where(and(isNull(t.deletedAt), gte(t.date, sql`date('now', '-365 days')`)))
    .groupBy(t.categoryId)
    .orderBy(desc(count()))
    .all();
  // Saved-but-unused subcategories (Settings → Categories) are offered too, after the used ones.
  const saved = db
    .select({ category: categories.name, subcategory: subcategoriesTable.name })
    .from(subcategoriesTable)
    .innerJoin(categories, eq(categories.id, subcategoriesTable.categoryId))
    .all()
    .filter(
      (s) =>
        !subcategories.some(
          (u) => u.category === s.category && u.subcategory.toLowerCase() === s.subcategory.toLowerCase(),
        ),
    )
    .map((s) => ({ ...s, uses: 0 }));
  return { vendors, subcategories: [...subcategories, ...saved], accounts, category_use: categoryUse };
}
