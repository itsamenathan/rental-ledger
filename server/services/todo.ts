/** Everything that needs the user's attention, in one place (the To do page, nav badge and agents). */
import type { DB } from "../db.ts";
import { listTransactions } from "./ledger.ts";
import { recurring } from "./recurring.ts";

export function todoSummary(db: DB, opts: { propertyId?: number; today?: string } = {}) {
  const count = (q: Record<string, unknown>) =>
    listTransactions(db, { ...q, property_id: opts.propertyId, limit: 1 }).total;
  const rec = recurring(db, opts);
  const flagged = count({ needs_review: "true" });
  const unallocated = count({ kind: "expense", allocation: "none" });
  const recurringWarnings = rec.alerts.filter((a) => a.level === "warning").length;
  const recurringNotes = rec.alerts.length - recurringWarnings;
  const year = (opts.today ?? new Date().toISOString()).slice(0, 4);
  return {
    /** what the badge shows: things that are probably wrong or missing */
    total: flagged + unallocated + recurringWarnings,
    flagged,
    unallocated,
    recurring: recurringWarnings,
    recurring_notes: recurringNotes,
    /** optional: $75+ expenses this year with no receipt (not counted in total) */
    missing_receipts: count({ kind: "expense", has_attachment: "false", min_amount: 75, year }),
    alerts: rec.alerts,
  };
}
