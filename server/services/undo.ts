/**
 * Undo a change from the audit log. Each supported entry is reversed with the normal service functions (so the
 * reversal is itself validated and audited), then an "undo" entry is written pointing at the original so it can't
 * be undone twice.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "../db.ts";
import { tx } from "../db.ts";
import { auditLog, occupancy, recurringDismissals, subcategories, transactions } from "../db/schema.ts";
import { audit, AppError, badRequest, notFound, requireWrite, type Actor } from "../context.ts";
import * as ledger from "./ledger.ts";
import { deleteOccupancy, upsertOccupancy } from "./rental.ts";
import { dismiss, undismiss } from "./recurring.ts";
import { addReceiptExclusion, listReceiptExclusions, removeReceiptExclusion } from "./receipts.ts";
import { setSubcategoryReceiptRule } from "./categories.ts";

type Row = typeof auditLog.$inferSelect;
type Changes = Record<string, unknown>;
type Diff = Record<string, [unknown, unknown]>;

const TX_FIELDS = [
  "date",
  "amount",
  "category_id",
  "subcategory",
  "vendor",
  "allocation",
  "description",
  "account",
  "reference",
  "needs_review",
  "review_note",
  "property_id",
];
const CATEGORY_FIELDS = [
  "name",
  "kind",
  "default_allocation",
  "schedule_e_line",
  "description",
  "sort_order",
  "archived",
  "receipt_policy",
  "receipt_min",
];
const PROPERTY_FIELDS = [
  "name",
  "address",
  "placed_in_service",
  "building_basis",
  "recovery_years",
  "notes",
  "archived",
];
const OCCUPANCY_FIELDS = ["nights_available", "nights_booked", "owner_nights", "check_ins", "notes"];

/** The "before" side of a field diff, limited to fields we can write back. */
const before = (d: Diff, fields: string[]) =>
  Object.fromEntries(
    Object.entries(d)
      .filter(([k]) => fields.includes(k))
      .map(([k, [b]]) => [k, b]),
  );

interface Plan {
  /** Shown on the button's confirmation, e.g. "Put back amount -50.00 → -42.50" */
  describe: string;
  run: (db: DB, actor: Actor) => void;
}

/** How to reverse an audit entry, or null if it can't be undone. */
function plan(r: Row): Plan | null {
  const c = (r.changes ?? {}) as Changes;
  const id = r.entityId;
  const ids = (c.ids ?? c.transactions) as number[] | undefined;

  switch (`${r.entity}:${r.action}`) {
    case "transaction:update": {
      if (!id) return null;
      const patch = before(c as Diff, TX_FIELDS);
      if (!Object.keys(patch).length) return null;
      return {
        describe: `Put back ${Object.keys(patch).join(", ")} on transaction #${id}`,
        // refund:true skips the sign check: we're restoring values that were valid before
        run: (db, a) => ledger.updateTransaction(db, a, id, { ...patch, refund: true }),
      };
    }
    case "transaction:create":
      return id ? { describe: `Delete transaction #${id}`, run: (db, a) => ledger.deleteTransaction(db, a, id) } : null;
    case "transaction:delete":
      return id
        ? { describe: `Restore transaction #${id}`, run: (db, a) => ledger.restoreTransaction(db, a, id) }
        : null;
    case "transaction:restore":
      return id
        ? { describe: `Delete transaction #${id} again`, run: (db, a) => ledger.deleteTransaction(db, a, id) }
        : null;
    case "transaction:bulk_create":
      return ids?.length
        ? {
            describe: `Delete the ${ids.length} transaction(s) that were added`,
            run: (db, a) => {
              const live = db
                .select({ id: transactions.id })
                .from(transactions)
                .where(and(inArray(transactions.id, ids), isNull(transactions.deletedAt)))
                .all();
              for (const t of live) ledger.deleteTransaction(db, a, t.id);
            },
          }
        : null;

    case "category:update": {
      if (!id) return null;
      const patch = before(c as Diff, CATEGORY_FIELDS);
      return Object.keys(patch).length
        ? {
            describe: `Put back ${Object.keys(patch).join(", ")} on the category`,
            run: (db, a) => ledger.updateCategory(db, a, id, patch),
          }
        : null;
    }
    case "category:create":
      return id
        ? { describe: "Delete the category (only if unused)", run: (db, a) => ledger.deleteCategory(db, a, id) }
        : null;
    case "property:update": {
      if (!id) return null;
      const patch = before(c as Diff, PROPERTY_FIELDS);
      return Object.keys(patch).length
        ? {
            describe: `Put back ${Object.keys(patch).join(", ")} on the property`,
            run: (db, a) => ledger.updateProperty(db, a, id, patch),
          }
        : null;
    }

    case "subcategory:rename":
    case "subcategory:delete": {
      const name = (r.action === "rename" ? c.from : c.name) as string | undefined;
      if (!name || !id || !Array.isArray(c.transactions)) return null;
      const txIds = c.transactions as number[];
      return {
        describe: `Set ${txIds.length} transaction(s) back to subcategory "${name}"`,
        run: (db, a) => {
          requireWrite(a);
          if (txIds.length)
            db.update(transactions)
              .set({ subcategory: name, updatedBy: a.user.id, updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')` })
              .where(inArray(transactions.id, txIds))
              .run();
          const saved = db
            .select({ id: subcategories.id })
            .from(subcategories)
            .where(and(eq(subcategories.categoryId, id), eq(sql`lower(${subcategories.name})`, name.toLowerCase())))
            .get();
          if (!saved) db.insert(subcategories).values({ categoryId: id, name }).run();
          audit(db, a, "update", "transaction", null, { subcategory: name, transactions: txIds });
        },
      };
    }
    case "subcategory:create":
      return id && typeof c.name === "string"
        ? {
            describe: `Remove saved subcategory "${c.name}"`,
            run: (db, a) => {
              requireWrite(a);
              db.delete(subcategories)
                .where(and(eq(subcategories.categoryId, id), eq(subcategories.name, c.name as string)))
                .run();
              audit(db, a, "delete", "subcategory", id, { name: c.name });
            },
          }
        : null;

    case "occupancy:create":
      return id ? { describe: "Delete that month's occupancy", run: (db, a) => deleteOccupancy(db, a, id) } : null;
    case "occupancy:update": {
      if (!id) return null;
      const patch = before(c as Diff, OCCUPANCY_FIELDS);
      return Object.keys(patch).length
        ? {
            describe: `Put back ${Object.keys(patch).join(", ")} for the month`,
            run: (db, a) => {
              const cur = db.select().from(occupancy).where(eq(occupancy.id, id)).get();
              if (!cur) throw notFound("Occupancy month");
              upsertOccupancy(db, a, {
                property_id: cur.propertyId,
                month: cur.month,
                nights_available: cur.nightsAvailable,
                nights_booked: cur.nightsBooked,
                owner_nights: cur.ownerNights,
                check_ins: cur.checkIns,
                notes: cur.notes,
                ...patch,
              });
            },
          }
        : null;
    }
    case "occupancy:delete":
      return typeof c.month === "string"
        ? {
            describe: `Re-create occupancy for ${c.month}`,
            run: (db, a) => upsertOccupancy(db, a, { ...c, property_id: c.property_id }),
          }
        : null;

    case "recurring_dismissal:create":
      return id
        ? {
            describe: "Flag it again",
            run: (db, a) => {
              if (
                db
                  .select({ id: recurringDismissals.id })
                  .from(recurringDismissals)
                  .where(eq(recurringDismissals.id, id))
                  .get()
              )
                undismiss(db, a, id);
            },
          }
        : null;
    case "subcategory:update": {
      // a subcategory receipt rule change: {name, receipt_policy: [before, after], receipt_min: [before, after]}
      if (!id || typeof c.name !== "string" || !Array.isArray(c.receipt_policy)) return null;
      const [policy] = c.receipt_policy as [string | null, string | null];
      const [min] = (c.receipt_min ?? [null, null]) as [number | null, number | null];
      return {
        describe: `Put back the receipt rule on ${c.name}`,
        run: (db, a) =>
          setSubcategoryReceiptRule(db, a, {
            category: id,
            name: c.name,
            receipt_policy: policy ?? "inherit",
            receipt_min: min,
          }),
      };
    }
    case "receipt_exclusion:create":
      return typeof c.name === "string"
        ? {
            describe: `Ask for receipts for ${c.name} again`,
            run: (db, a) => {
              if (listReceiptExclusions(db).some((x) => x.id === id)) removeReceiptExclusion(db, a, id!);
            },
          }
        : null;
    case "receipt_exclusion:delete":
      return typeof c.name === "string"
        ? {
            describe: `Stop asking for receipts for ${c.name} again`,
            run: (db, a) => addReceiptExclusion(db, a, { name: c.name, note: c.note ?? "" }),
          }
        : null;
    case "recurring_dismissal:delete":
      return typeof c.series_key === "string"
        ? {
            describe: "Mark it as fine again",
            run: (db, a) => dismiss(db, a, { series_key: c.series_key, month: c.month ?? null }),
          }
        : null;
  }
  return null;
}

/** For the audit log screen: what undo would do, and whether it already happened. */
export function annotate<
  T extends { id: number; action: string; entity: string; entity_id: number | null; changes: unknown },
>(db: DB, rows: T[]) {
  const undone = new Set(
    db
      .select({ target: auditLog.entityId })
      .from(auditLog)
      .where(and(eq(auditLog.action, "undo"), eq(auditLog.entity, "audit")))
      .all()
      .map((r) => r.target),
  );
  return rows.map((r) => {
    const p = plan({ ...r, entityId: r.entity_id } as unknown as Row);
    return { ...r, undo: p ? p.describe : null, undone: undone.has(r.id) };
  });
}

export function undoAudit(db: DB, actor: Actor, auditId: number) {
  requireWrite(actor);
  const row = db.select().from(auditLog).where(eq(auditLog.id, auditId)).get();
  if (!row) throw notFound("Audit entry");
  const already = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, "undo"), eq(auditLog.entity, "audit"), eq(auditLog.entityId, auditId)))
    .get();
  if (already) throw badRequest("That change was already undone");
  const p = plan(row);
  if (!p) throw badRequest(`"${row.action} ${row.entity}" can't be undone automatically`);
  try {
    tx(db, () => {
      p.run(db, actor);
      audit(db, actor, "undo", "audit", auditId, { action: row.action, entity: row.entity, entity_id: row.entityId });
    });
  } catch (e) {
    if (e instanceof AppError) throw badRequest(`Couldn't undo: ${e.message}`);
    throw e;
  }
  return { ok: true, undone: auditId, did: p.describe };
}
