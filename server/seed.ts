import { count, eq } from "drizzle-orm";
import type { DB } from "./db.ts";
import { categories, portfolios, properties } from "./db/schema.ts";
import { createCategory, createProperty } from "./services/ledger.ts";
import { currentPortfolioId, inPortfolio } from "./portfolio.ts";

type NewCategory = {
  name: string;
  kind: "income" | "expense";
  schedule_e_line: string;
  default_allocation: "direct" | "indirect" | null;
};

/**
 * Starter categories for a new portfolio: the lines of the preparer's rental worksheet, so a year's totals copy
 * straight onto it. Each has a Schedule E line and a default allocation: direct (only for the rental activity) or
 * indirect (operating or maintaining the dwelling: repairs, insurance, utilities, interest, real estate tax), which a
 * single entry can still override. Edit freely in Settings.
 */
export const DEFAULT_CATEGORIES = [
  { name: "Rental Income", kind: "income", schedule_e_line: "3", default_allocation: null },
  { name: "Advertising", kind: "expense", schedule_e_line: "5", default_allocation: "direct" },
  { name: "Association dues", kind: "expense", schedule_e_line: "19", default_allocation: "indirect" },
  { name: "Auto and travel", kind: "expense", schedule_e_line: "6", default_allocation: "direct" },
  { name: "Cleaning and maintenance", kind: "expense", schedule_e_line: "7", default_allocation: "direct" },
  { name: "Commissions", kind: "expense", schedule_e_line: "8", default_allocation: "direct" },
  { name: "Gardening", kind: "expense", schedule_e_line: "7", default_allocation: "indirect" },
  { name: "Insurance", kind: "expense", schedule_e_line: "9", default_allocation: "indirect" },
  { name: "Legal and professional fees", kind: "expense", schedule_e_line: "10", default_allocation: "direct" },
  { name: "Licenses and permits", kind: "expense", schedule_e_line: "19", default_allocation: "direct" },
  { name: "Management fees", kind: "expense", schedule_e_line: "11", default_allocation: "direct" },
  { name: "Miscellaneous", kind: "expense", schedule_e_line: "19", default_allocation: "direct" },
  { name: "Mortgage interest", kind: "expense", schedule_e_line: "12", default_allocation: "indirect" },
  { name: "Excess mortgage interest", kind: "expense", schedule_e_line: "12", default_allocation: "indirect" },
  { name: "Other interest", kind: "expense", schedule_e_line: "13", default_allocation: "indirect" },
  { name: "Painting and decorating", kind: "expense", schedule_e_line: "14", default_allocation: "indirect" },
  { name: "Pest control", kind: "expense", schedule_e_line: "7", default_allocation: "indirect" },
  { name: "Plumbing and electrical", kind: "expense", schedule_e_line: "14", default_allocation: "indirect" },
  { name: "Repairs", kind: "expense", schedule_e_line: "14", default_allocation: "indirect" },
  { name: "Supplies", kind: "expense", schedule_e_line: "15", default_allocation: "direct" },
  { name: "Taxes - real estate", kind: "expense", schedule_e_line: "16", default_allocation: "indirect" },
  { name: "Taxes - other", kind: "expense", schedule_e_line: "16", default_allocation: "direct" },
  { name: "Telephone", kind: "expense", schedule_e_line: "17", default_allocation: "indirect" },
  { name: "Utilities", kind: "expense", schedule_e_line: "17", default_allocation: "indirect" },
  { name: "Wages and salaries", kind: "expense", schedule_e_line: "19", default_allocation: "direct" },
] as const;

/**
 * At startup: a brand-new install's only portfolio gets its defaults. With several portfolios there's nothing to do
 * (each is seeded when it's created, services/portfolios.ts).
 */
export function seedFirstRun(db: DB) {
  const open = db.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.archived, false)).limit(2).all();
  if (open.length === 1) inPortfolio(open[0]!.id, () => seedDefaults(db));
}

/** Default categories (or `list`) and a first property for the current portfolio, if it has none. */
export function seedDefaults(db: DB, list: readonly NewCategory[] = DEFAULT_CATEGORIES) {
  const pid = currentPortfolioId(db);
  const hasCategories = db.select({ n: count() }).from(categories).where(eq(categories.portfolioId, pid)).get()!.n > 0;
  if (!hasCategories) list.forEach((c, i) => createCategory(db, null, { ...c, sort_order: i }));
  const hasProperties = db.select({ n: count() }).from(properties).where(eq(properties.portfolioId, pid)).get()!.n > 0;
  if (!hasProperties) createProperty(db, null, { name: process.env.DEFAULT_PROPERTY_NAME ?? "My Rental" });
}
