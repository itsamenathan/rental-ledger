/**
 * Which expenses should have a receipt. This is the only place that decides it: the To do count, the Files page's
 * "Needs a receipt" list, the tax report's missing_receipts check and the transactions `needs_receipt` filter all
 * use `needsReceipt`, so they always agree.
 *
 * An expense needs a receipt when it is a live outflow (amount < 0) in an expense category, has no attachment, and:
 *   - its category's policy is 'always', or
 *   - the policy is 'threshold' (the default) and it is at least the category's receipt_min (or RECEIPT_MIN_DOLLARS),
 *   - and neither its vendor nor its subcategory is on the "never ask" list (receipt_exclusions).
 * Policy 'never' (the default for mortgage, Schedule E line 12) never asks.
 *
 * Only imports the schema, so ledger.ts can use it without a cycle.
 */
import { and, eq, isNull, lt, not, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db.ts";
import { attachments, categories, receiptExclusions, transactions } from "../db/schema.ts";
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
const e = receiptExclusions;

/**
 * SQL condition: this transaction needs a receipt it doesn't have. Use in a query over `transactions` joined to
 * `categories` (on category_id).
 */
export function needsReceipt(): SQL {
  const hasAttachment = sql`EXISTS (SELECT 1 FROM ${attachments} WHERE ${attachments.transactionId} = ${t.id})`;
  const excluded = sql`EXISTS (SELECT 1 FROM ${e}
    WHERE lower(${e.name}) IN (lower(trim(${t.vendor})), lower(trim(${t.subcategory}))))`;
  const byPolicy = sql`CASE ${c.receiptPolicy}
    WHEN 'never' THEN 0
    WHEN 'always' THEN 1
    ELSE -${t.amountCents} >= coalesce(${c.receiptMinCents}, ${RECEIPT_MIN_DOLLARS * 100})
  END`;
  return and(
    isNull(t.deletedAt),
    eq(c.kind, "expense"),
    lt(t.amountCents, 0),
    byPolicy,
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

// ---------- "never ask" names ----------

export interface ReceiptExclusion {
  id: number;
  name: string;
  note: string;
  /** live expenses whose vendor or subcategory has this name */
  matches: number;
}

export function listReceiptExclusions(db: DB): ReceiptExclusion[] {
  const matches = sql<number>`(SELECT count(*) FROM ${t} WHERE ${t.deletedAt} IS NULL AND ${t.amountCents} < 0
    AND lower(${e.name}) IN (lower(trim(${t.vendor})), lower(trim(${t.subcategory}))))`.mapWith(Number);
  return db
    .select({ id: e.id, name: e.name, note: e.note, matches })
    .from(e)
    .orderBy(sql`lower(${e.name})`)
    .all();
}

export const receiptExclusionInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(100).describe("Vendor or subcategory name, e.g. Airbnb"),
  note: z.string().trim().max(500).default(""),
});

/** Stop asking for receipts for a vendor/subcategory name. Adding an existing name just returns it. */
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

/** Remove a name from the list, by id or name. */
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
  if (!row) throw notFound("Receipt exclusion");
  db.delete(e).where(eq(e.id, row.id)).run();
  audit(db, actor, "delete", "receipt_exclusion", row.id, { name: row.name, note: row.note });
  return { removed: row.name };
}

/**
 * Keep the list in step when a subcategory is renamed (called inside renameSubcategory's transaction, after the
 * update). Left alone while other entries still use the old name as a vendor or subcategory.
 */
export function renameReceiptExclusion(db: DB, from: string, to: string) {
  if (from.trim().toLowerCase() === to.trim().toLowerCase()) return;
  const old = from.trim().toLowerCase();
  const stillUsed = db
    .select({ id: t.id })
    .from(t)
    .where(sql`${t.deletedAt} IS NULL AND ${old} IN (lower(trim(${t.vendor})), lower(trim(${t.subcategory})))`)
    .get();
  if (stillUsed) return;
  const row = db
    .select({ id: e.id })
    .from(e)
    .where(eq(sql`lower(${e.name})`, from.trim().toLowerCase()))
    .get();
  if (!row) return;
  const clash = db
    .select({ id: e.id })
    .from(e)
    .where(eq(sql`lower(${e.name})`, to.trim().toLowerCase()))
    .get();
  if (clash) db.delete(e).where(eq(e.id, row.id)).run();
  else db.update(e).set({ name: to.trim() }).where(eq(e.id, row.id)).run();
}
