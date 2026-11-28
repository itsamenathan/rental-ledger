/**
 * Which portfolio the current work belongs to (docs/plans/portfolios.md).
 *
 * A request's portfolio is set once, after sign-in, from the API key or the person's membership (`inRequest`), and
 * every service reads it with `currentPortfolioId`. Outside a request (CLI, scheduler, tests, seeding) there is no
 * request scope, and the only active portfolio is used; with several, the caller has to say which (`inPortfolio`).
 * A request whose caller has no portfolio never falls back to the sole one: that would show it to anyone signed in.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { AppError } from "./context.ts";
import type { DB } from "./db.ts";
import { portfolios } from "./db/schema.ts";

type Scope = { portfolioId: number | null; why?: string };

// Survive Vite dev-server module reloads, like getDb: a reloaded module must see the scope a request set.
const g = globalThis as unknown as { __rentalPortfolioScope?: AsyncLocalStorage<Scope> };
const store = (g.__rentalPortfolioScope ??= new AsyncLocalStorage<Scope>());

/**
 * Run a request's work in its caller's portfolio. null = signed out, or signed in without one (`why` says which
 * case: no membership, or several and none picked); only touching a portfolio's data then fails.
 */
export function inRequest<T>(portfolioId: number | null, fn: () => T, why?: string): T {
  return store.run({ portfolioId, why }, fn);
}

/** Run background or CLI work in one portfolio. */
export function inPortfolio<T>(portfolioId: number, fn: () => T): T {
  return store.run({ portfolioId }, fn);
}

/** The current portfolio. Throws 403 in a request without one, and 400 outside requests when several exist. */
export function currentPortfolioId(db: DB): number {
  const scope = store.getStore();
  if (scope) {
    if (scope.portfolioId == null)
      // `no_access` lets the app tell "lost access to this portfolio" apart from other refusals.
      throw new AppError(403, scope.why ?? "You don't have access to a portfolio yet", { code: "no_access" });
    return scope.portfolioId;
  }
  return onlyPortfolioId(db);
}

/** The only active portfolio, whatever the request scope (first-run setup, CLI). 400 with none or several. */
export function onlyPortfolioId(db: DB): number {
  const rows = db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(eq(portfolios.archived, false))
    .orderBy(portfolios.id)
    .limit(2)
    .all();
  if (rows.length === 1) return rows[0]!.id;
  throw new AppError(400, rows.length ? "Several portfolios exist; say which one" : "No portfolio exists");
}

/** The current portfolio, or null when there is none (audit entries about a login rather than any portfolio). */
export function currentPortfolioIdOrNull(db: DB): number | null {
  try {
    return currentPortfolioId(db);
  } catch {
    return null;
  }
}

/**
 * Filter on a property column (`<table>.property_id`): one property, else every property of the current portfolio.
 * Replaces `propertyId ? eq(col, propertyId) : undefined`, which would add up every portfolio. A given property is
 * checked against the portfolio too, so an id that slipped past resolvePropertyId matches nothing.
 */
export function propertyScope(db: DB, col: SQLiteColumn, propertyId?: number | null): SQL {
  const inPortfolio = sql`${col} IN (SELECT id FROM properties WHERE portfolio_id = ${currentPortfolioId(db)})`;
  return propertyId ? and(eq(col, propertyId), inPortfolio)! : inPortfolio;
}
