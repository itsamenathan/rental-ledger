/** Everything that needs the user's attention, in one place (the To do page, nav badge and agents). */
import type { DB } from "../db.ts";
import { listTransactions } from "./ledger.ts";
import { recurring } from "./recurring.ts";
import { managerAttention } from "./manager-statement.ts";

export function todoSummary(db: DB, opts: { propertyId?: number; today?: string } = {}) {
  const count = (q: Record<string, unknown>) =>
    listTransactions(db, { ...q, property_id: opts.propertyId, limit: 1 }).total;
  const rec = recurring(db, opts);
  const flagged = count({ needs_review: "true" });
  const unallocated = count({ kind: "expense", allocation: "none" });
  const recurringWarnings = rec.alerts.filter((a) => a.level === "warning").length;
  const recurringNotes = rec.alerts.length - recurringWarnings;
  const year = (opts.today ?? new Date().toISOString()).slice(0, 4);
  // Saved manager statements with entries to add or unexplained differences.
  const manager = managerAttention(db, { propertyId: opts.propertyId });
  return {
    /** what the badge shows: things that are probably wrong or missing */
    total: flagged + unallocated + recurringWarnings + manager.length,
    flagged,
    unallocated,
    recurring: recurringWarnings,
    recurring_notes: recurringNotes,
    /** months of manager paperwork that need attention */
    manager: manager.length,
    manager_months: manager,
    /** optional: expenses this year that should have a receipt and don't (services/receipts.ts; not in total) */
    missing_receipts: count({ needs_receipt: true, year }),
    alerts: rec.alerts,
  };
}
