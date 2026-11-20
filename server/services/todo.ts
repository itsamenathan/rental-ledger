/** Everything that needs the user's attention, in one place (the To do page, nav badge and agents). */
import type { DB } from "../db.ts";
import { listTransactions } from "./ledger.ts";
import { recurring } from "./recurring.ts";
import { managerAttention } from "./manager-statement.ts";
import { occupancyAttention } from "./occupancy-calendar.ts";

/** Last month of tax season (April): until then, the To do page asks about last year's receipts. */
const TAX_SEASON_END = 4;

export function todoSummary(db: DB, opts: { propertyId?: number; today?: string } = {}) {
  const count = (q: Record<string, unknown>) =>
    listTransactions(db, { ...q, property_id: opts.propertyId, limit: 1 }).total;
  const rec = recurring(db, opts);
  const flagged = count({ needs_review: "true" });
  const unallocated = count({ kind: "expense", allocation: "none" });
  // an entry that's flagged and has no allocation is one row on the To do page, so the badge counts it once
  const unallocatedNotFlagged = count({ kind: "expense", allocation: "none", needs_review: "false" });
  const recurringWarnings = rec.alerts.filter((a) => a.level === "warning").length;
  const recurringNotes = rec.alerts.length - recurringWarnings;
  // Receipts are for the tax year being worked on: last year until the end of April, then this year.
  const now = opts.today ?? new Date().toISOString();
  const taxSeason = Number(now.slice(5, 7)) <= TAX_SEASON_END;
  const receiptsYear = Number(now.slice(0, 4)) - (taxSeason ? 1 : 0);
  // Saved manager statements with entries to add or unexplained differences.
  const manager = managerAttention(db, { propertyId: opts.propertyId });
  // Likely owner stays to confirm and guest nights that disagree with the calendar (services/occupancy-calendar.ts).
  const occupancy = occupancyAttention(db, opts);
  const occupancyItems = occupancy.reduce((a, o) => a + o.owner_stays.length + o.guest_nights.length, 0);
  return {
    /** what the badge shows: things that are probably wrong or missing */
    total: flagged + unallocatedNotFlagged + recurringWarnings + manager.length + occupancyItems,
    flagged,
    unallocated,
    recurring: recurringWarnings,
    recurring_notes: recurringNotes,
    /** months of manager paperwork that need attention */
    manager: manager.length,
    manager_months: manager,
    /** owner stays to confirm + guest-night months to check */
    occupancy: occupancyItems,
    occupancy_items: occupancy,
    /** optional: expenses in receipts_year that should have a receipt and don't (services/receipts.ts; not in total) */
    missing_receipts: count({ needs_receipt: true, year: String(receiptsYear) }),
    receipts_year: receiptsYear,
    /** true from January to April, when the To do page shows the receipts count */
    tax_season: taxSeason,
    alerts: rec.alerts,
  };
}
