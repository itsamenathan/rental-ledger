/**
 * Category and subcategory housekeeping: saved subcategories, renaming/merging, removing, and deleting a category
 * by moving its transactions elsewhere. Subcategories live as text on transactions (the Grist layout); the
 * subcategories table only remembers names so they can be offered before first use.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { categories, recurringDismissals, subcategories, transactions } from "../db/schema.ts";
import { audit, badRequest, cents, dollars, requireAdmin, requireWrite, type Actor } from "../context.ts";
import { deleteCategory, getCategory, resolveCategory } from "./ledger.ts";
import { RECEIPT_POLICIES, type ReceiptPolicy } from "./receipts.ts";

const t = transactions;
const ref = z.union([z.number().int(), z.string().min(1)]);
const subName = z.string().trim().min(1, "Name is required").max(60);
const lower = (s: string) => s.trim().toLowerCase();
const sameSub = (name: string) => eq(sql`lower(${t.subcategory})`, lower(name));

export interface SubcategoryInfo {
  category_id: number;
  name: string;
  count: number;
  saved: boolean;
  /** own receipt rule; null = same as the category */
  receipt_policy: ReceiptPolicy | null;
  /** dollars, for 'threshold'; null = the category's amount */
  receipt_min: number | null;
}

/** Every subcategory per category: saved ones plus any used on transactions, with transaction counts and rules. */
export function listSubcategories(db: DB): SubcategoryInfo[] {
  const used = db
    .select({ category_id: t.categoryId, name: t.subcategory, count: count() })
    .from(t)
    .where(and(sql`${t.deletedAt} IS NULL`, sql`${t.subcategory} <> ''`))
    .groupBy(t.categoryId, t.subcategory)
    .all();
  const saved = db.select().from(subcategories).all();
  const out = new Map<string, SubcategoryInfo>();
  const none = { saved: false, receipt_policy: null, receipt_min: null };
  for (const u of used) {
    const k = `${u.category_id}|${lower(u.name)}`;
    const prev = out.get(k);
    // differently-cased variants: keep the most used spelling, add up counts
    if (prev) out.set(k, { ...prev, name: u.count > prev.count ? u.name : prev.name, count: prev.count + u.count });
    else out.set(k, { category_id: u.category_id, name: u.name, count: u.count, ...none });
  }
  for (const s of saved) {
    const k = `${s.categoryId}|${lower(s.name)}`;
    const prev = out.get(k);
    const rule = { saved: true, receipt_policy: s.receiptPolicy, receipt_min: dollars(s.receiptMinCents) };
    out.set(k, prev ? { ...prev, ...rule } : { category_id: s.categoryId, name: s.name, count: 0, ...rule });
  }
  return [...out.values()].sort(
    (a, b) => a.category_id - b.category_id || b.count - a.count || a.name.localeCompare(b.name),
  );
}

/** Transaction counts per category (live transactions only). */
export function categoryUsage(db: DB) {
  return db
    .select({ category_id: t.categoryId, count: count() })
    .from(t)
    .where(sql`${t.deletedAt} IS NULL`)
    .groupBy(t.categoryId)
    .all();
}

function savedRow(db: DB, categoryId: number, name: string) {
  return db
    .select()
    .from(subcategories)
    .where(and(eq(subcategories.categoryId, categoryId), eq(sql`lower(${subcategories.name})`, lower(name))))
    .get();
}

/** Point recurring-bill dismissals at a series' new key after a rename/move, so dismissed months stay dismissed. */
function rekeyDismissals(db: DB, match: (cat: string, sub: string) => boolean, next: (parts: string[]) => string[]) {
  for (const d of db.select().from(recurringDismissals).all()) {
    const parts = d.seriesKey.split(":");
    if (parts.length !== 4 || !match(parts[1]!, parts[3]!)) continue;
    const key = next(parts).join(":");
    const clash = db
      .select({ id: recurringDismissals.id })
      .from(recurringDismissals)
      .where(and(eq(recurringDismissals.seriesKey, key), eq(recurringDismissals.month, d.month)))
      .get();
    if (clash) db.delete(recurringDismissals).where(eq(recurringDismissals.id, d.id)).run();
    else db.update(recurringDismissals).set({ seriesKey: key }).where(eq(recurringDismissals.id, d.id)).run();
  }
}

function touch(actor: Actor) {
  return { updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`, updatedBy: actor.user.id };
}

// ---------- subcategories ----------

export const addSubcategoryInput = z.object({ category: ref, name: subName });

export function addSubcategory(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const p = addSubcategoryInput.parse(raw);
  const cat = resolveCategory(db, p.category);
  const existing = savedRow(db, cat.id, p.name);
  if (existing) return { category_id: cat.id, name: existing.name };
  db.insert(subcategories).values({ categoryId: cat.id, name: p.name }).run();
  audit(db, actor, "create", "subcategory", cat.id, { category: cat.name, name: p.name });
  return { category_id: cat.id, name: p.name };
}

export const renameSubcategoryInput = z.object({ category: ref, from: subName, to: subName });

/** Rename a subcategory on every transaction in the category. Renaming onto an existing name merges them. */
export function renameSubcategory(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const p = renameSubcategoryInput.parse(raw);
  const cat = resolveCategory(db, p.category);
  return tx(db, () => {
    const ids = db
      .update(t)
      .set({ subcategory: p.to, ...touch(actor) })
      .where(and(eq(t.categoryId, cat.id), sameSub(p.from)))
      .returning({ id: t.id })
      .all()
      .map((r) => r.id);
    const src = savedRow(db, cat.id, p.from);
    const dst = lower(p.from) === lower(p.to) ? undefined : savedRow(db, cat.id, p.to);
    if (src && dst) db.delete(subcategories).where(eq(subcategories.id, src.id)).run();
    else if (src) db.update(subcategories).set({ name: p.to }).where(eq(subcategories.id, src.id)).run();
    if (!src && !ids.length) throw badRequest(`No subcategory "${p.from}" in ${cat.name}`);
    rekeyDismissals(
      db,
      (c, s) => c === String(cat.id) && s === lower(p.from),
      ([pr, c, v]) => [pr!, c!, v!, lower(p.to)],
    );
    audit(db, actor, "rename", "subcategory", cat.id, {
      category: cat.name,
      from: p.from,
      to: p.to,
      transactions: ids,
    });
    return { category: cat.name, from: p.from, to: p.to, updated: ids.length };
  });
}

export const removeSubcategoryInput = z.object({
  category: ref,
  name: subName,
  move_to: z.string().trim().max(60).default("").describe("Subcategory to move its transactions to; empty = none"),
});

/** Remove a subcategory: its transactions are moved to another subcategory, or left with none. */
export function removeSubcategory(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const p = removeSubcategoryInput.parse(raw);
  if (p.move_to && lower(p.move_to) === lower(p.name)) throw badRequest("Pick a different subcategory to move to");
  const cat = resolveCategory(db, p.category);
  return tx(db, () => {
    const ids = db
      .update(t)
      .set({ subcategory: p.move_to, ...touch(actor) })
      .where(and(eq(t.categoryId, cat.id), sameSub(p.name)))
      .returning({ id: t.id })
      .all()
      .map((r) => r.id);
    db.delete(subcategories)
      .where(and(eq(subcategories.categoryId, cat.id), eq(sql`lower(${subcategories.name})`, lower(p.name))))
      .run();
    rekeyDismissals(
      db,
      (c, s) => c === String(cat.id) && s === lower(p.name),
      ([pr, c, v]) => [pr!, c!, v!, lower(p.move_to)],
    );
    audit(db, actor, "delete", "subcategory", cat.id, {
      category: cat.name,
      name: p.name,
      moved_to: p.move_to || null,
      transactions: ids,
    });
    return { category: cat.name, removed: p.name, moved_to: p.move_to || null, updated: ids.length };
  });
}

export const subcategoryReceiptRuleInput = z.object({
  category: ref,
  name: subName,
  receipt_policy: z
    .enum([...RECEIPT_POLICIES, "inherit"])
    .describe("always | threshold | never, or inherit = same as the category"),
  receipt_min: z
    .number()
    .finite()
    .positive()
    .max(1e9)
    .nullable()
    .optional()
    .describe("Dollar threshold for 'threshold'; null = the category's"),
});

/**
 * Give a subcategory its own receipt rule, or put it back to the category's ("inherit"). A subcategory that's only
 * used on transactions is saved first, so the rule has somewhere to live.
 */
export function setSubcategoryReceiptRule(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const p = subcategoryReceiptRuleInput.parse(raw);
  const cat = resolveCategory(db, p.category);
  if (cat.kind !== "expense") throw badRequest("Receipt rules are for expense categories");
  const policy = p.receipt_policy === "inherit" ? null : p.receipt_policy;
  const minCents = policy === "threshold" && p.receipt_min != null ? cents(p.receipt_min) : null;
  return tx(db, () => {
    let row = savedRow(db, cat.id, p.name);
    if (!row) {
      // keep the spelling used on transactions
      const used = listSubcategories(db).find((x) => x.category_id === cat.id && lower(x.name) === lower(p.name));
      row = db
        .insert(subcategories)
        .values({ categoryId: cat.id, name: used?.name ?? p.name })
        .returning()
        .get();
    }
    const before = { receipt_policy: row.receiptPolicy, receipt_min: dollars(row.receiptMinCents) };
    db.update(subcategories)
      .set({ receiptPolicy: policy, receiptMinCents: minCents })
      .where(eq(subcategories.id, row.id))
      .run();
    const after = { receipt_policy: policy, receipt_min: dollars(minCents) };
    audit(db, actor, "update", "subcategory", cat.id, {
      category: cat.name,
      name: row.name,
      receipt_policy: [before.receipt_policy, after.receipt_policy],
      receipt_min: [before.receipt_min, after.receipt_min],
    });
    return { category_id: cat.id, category: cat.name, name: row.name, ...after };
  });
}

// ---------- categories ----------

export const deleteCategoryInput = z.object({
  move_to: ref.optional().describe("Category to move this category's transactions (and subcategories) to"),
});

/** Delete a category. If it has transactions, `move_to` names the category that takes them over (a merge). */
export function deleteCategoryMoving(db: DB, actor: Actor, id: number, raw: unknown = {}) {
  requireAdmin(actor);
  const p = deleteCategoryInput.parse(raw ?? {});
  const from = getCategory(db, id);
  if (p.move_to == null) {
    deleteCategory(db, actor, id);
    return { deleted: from.name, moved: 0 };
  }
  const to = resolveCategory(db, p.move_to);
  if (to.id === from.id) throw badRequest("Pick a different category to move to");
  if (to.kind !== from.kind) throw badRequest(`Can't move ${from.kind} transactions into an ${to.kind} category`);
  return tx(db, () => {
    const ids = db
      .update(t)
      .set({ categoryId: to.id, ...touch(actor) })
      .where(eq(t.categoryId, from.id))
      .returning({ id: t.id })
      .all()
      .map((r) => r.id);
    // Subcategories (and their receipt rules) come along, unless the target already has one by that name.
    for (const s of db.select().from(subcategories).where(eq(subcategories.categoryId, from.id)).all())
      if (!savedRow(db, to.id, s.name))
        db.insert(subcategories)
          .values({
            categoryId: to.id,
            name: s.name,
            receiptPolicy: s.receiptPolicy,
            receiptMinCents: s.receiptMinCents,
          })
          .run();
    rekeyDismissals(
      db,
      (c) => c === String(from.id),
      ([pr, , v, s]) => [pr!, String(to.id), v!, s!],
    );
    audit(db, actor, "update", "transaction", null, { category: [from.name, to.name], transactions: ids });
    deleteCategory(db, actor, from.id);
    return { deleted: from.name, moved_to: to.name, moved: ids.length };
  });
}

/** Categories with their transaction counts and subcategories, for the settings screen. */
export function categoryTree(db: DB) {
  const usage = new Map(categoryUsage(db).map((u) => [u.category_id, u.count]));
  const subs = listSubcategories(db);
  return db
    .select({ id: categories.id })
    .from(categories)
    .all()
    .map((c) => ({
      category_id: c.id,
      count: usage.get(c.id) ?? 0,
      subcategories: subs.filter((s) => s.category_id === c.id).map(({ category_id: _c, ...s }) => s),
    }));
}
