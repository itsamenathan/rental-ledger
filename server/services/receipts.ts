/**
 * Which expenses should have a receipt. This is the only place that decides it: the To do count, the Files page's
 * "Needs a receipt" list, the tax report's missing_receipts check and the transactions `needs_receipt` filter all
 * use `needsReceipt`, so they always agree.
 *
 * An expense needs a receipt when it is a live outflow (amount < 0) in an expense category, has no attachment, its
 * vendor isn't on the never-ask list (receipt_exclusions), and its rule asks for one. The rule is the subcategory's
 * (on `subcategories`, matched by category + name ignoring case) when set, otherwise the category's:
 *   - 'always': any amount
 *   - 'threshold' (default): at least receipt_min (subcategory's, else category's, else RECEIPT_MIN_DOLLARS)
 *   - 'never' (the default for mortgage, Schedule E line 12)
 *
 * Only imports the schema, so ledger.ts can use it without a cycle.
 */
import { and, eq, isNull, lt, not, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db.ts";
import { attachments, categories, receiptExclusions, subcategories, transactions } from "../db/schema.ts";
import { audit, notFound, requireWrite, type Actor } from "../context.ts";

/** App-wide default threshold for categories with policy 'threshold' and no override. */
export const RECEIPT_MIN_DOLLARS = 75;

export const RECEIPT_POLICIES = ["always", "threshold", "never"] as const;
export type ReceiptPolicy = (typeof RECEIPT_POLICIES)[number];

/** Policy for a new category that doesn't say: mortgage payments (line 12) never need one. */
export const defaultReceiptPolicy = (scheduleELine: string | null | undefined): ReceiptPolicy =>
  scheduleELine === "12" ? "never" : "threshold";

const t = transactions;
const c = categories;
const s = subcategories;
const e = receiptExclusions;

/** The transaction's subcategory rule column, or NULL when its subcategory has no rule of its own. */
const subRule = (col: typeof s.receiptPolicy | typeof s.receiptMinCents) =>
  sql`(SELECT ${col} FROM ${s} WHERE ${s.categoryId} = ${t.categoryId}
    AND lower(${s.name}) = lower(${t.subcategory}) AND ${s.receiptPolicy} IS NOT NULL LIMIT 1)`;

/**
 * SQL condition: this transaction needs a receipt it doesn't have. Use in a query over `transactions` joined to
 * `categories` (on category_id).
 */
export function needsReceipt(): SQL {
  const hasAttachment = sql`EXISTS (SELECT 1 FROM ${attachments} WHERE ${attachments.transactionId} = ${t.id})`;
  const excluded = sql`EXISTS (SELECT 1 FROM ${e} WHERE lower(${e.name}) = lower(trim(${t.vendor})))`;
  const byRule = sql`CASE coalesce(${subRule(s.receiptPolicy)}, ${c.receiptPolicy})
    WHEN 'never' THEN 0
    WHEN 'always' THEN 1
    ELSE -${t.amountCents} >= coalesce(${subRule(s.receiptMinCents)}, ${c.receiptMinCents}, ${RECEIPT_MIN_DOLLARS * 100})
  END`;
  return and(
    isNull(t.deletedAt),
    eq(c.kind, "expense"),
    lt(t.amountCents, 0),
    byRule,
    not(hasAttachment),
    not(excluded),
  )!;
}

/** Ids of expenses needing a receipt, oldest first (for tests and agents). */
export function missingReceiptIds(db: DB, where?: SQL): number[] {
  return db
    .select({ id: t.id })
    .from(t)
    .innerJoin(c, eq(c.id, t.categoryId))
    .where(and(needsReceipt(), where))
    .orderBy(t.date, t.id)
    .all()
    .map((r) => r.id);
}

// ---------- vendors that never need a receipt ----------

export interface ReceiptExclusion {
  id: number;
  name: string;
  note: string;
  /** live expenses from this vendor */
  matches: number;
}

export function listReceiptExclusions(db: DB): ReceiptExclusion[] {
  const matches = sql<number>`(SELECT count(*) FROM ${t} WHERE ${t.deletedAt} IS NULL AND ${t.amountCents} < 0
    AND lower(trim(${t.vendor})) = lower(${e.name}))`.mapWith(Number);
  return db
    .select({ id: e.id, name: e.name, note: e.note, matches })
    .from(e)
    .orderBy(sql`lower(${e.name})`)
    .all();
}

export const receiptExclusionInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(100).describe("Vendor name, e.g. Stripe"),
  note: z.string().trim().max(500).default(""),
});

/** Stop asking for receipts for a vendor, in any category. Adding an existing name just returns it. */
export function addReceiptExclusion(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const p = receiptExclusionInput.parse(raw);
  const existing = db
    .select({ id: e.id })
    .from(e)
    .where(eq(sql`lower(${e.name})`, p.name.toLowerCase()))
    .get();
  if (existing) return listReceiptExclusions(db).find((x) => x.id === existing.id)!;
  const { id } = db
    .insert(e)
    .values({ name: p.name, note: p.note, createdBy: actor.user.id })
    .returning({ id: e.id })
    .get();
  audit(db, actor, "create", "receipt_exclusion", id, p);
  return listReceiptExclusions(db).find((x) => x.id === id)!;
}

/** Ask for receipts from a vendor again, by id or name. */
export function removeReceiptExclusion(db: DB, actor: Actor, ref: number | string) {
  requireWrite(actor);
  const row = db
    .select()
    .from(e)
    .where(
      typeof ref === "number" || /^\d+$/.test(ref)
        ? or(eq(e.id, Number(ref)), eq(sql`lower(${e.name})`, String(ref).toLowerCase()))
        : eq(sql`lower(${e.name})`, ref.trim().toLowerCase()),
    )
    .get();
  if (!row) throw notFound("Vendor on the never-ask list");
  db.delete(e).where(eq(e.id, row.id)).run();
  audit(db, actor, "delete", "receipt_exclusion", row.id, { name: row.name, note: row.note });
  return { removed: row.name };
}
