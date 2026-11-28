import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import { config } from "../config.ts";
import { getDb } from "../db.ts";
import { log } from "../telemetry.ts";
import { AppError, type Actor, type Role, type Via } from "../context.ts";
import { inRequest } from "../portfolio.ts";
import { keyRole, portfolioForUser, recordInstanceAdminView } from "../services/portfolios.ts";
import { API_KEY_PREFIX, roleCanWrite, userForApiKey, userForSession } from "../services/auth.ts";

export const SESSION_COOKIE = "rental_session";

/** The portfolio this request works in, as /auth/me reports it. */
export interface RequestPortfolioInfo {
  slug: string;
  role: Role;
  /** the instance admin, looking at a portfolio they don't belong to (read-only) */
  viewing: boolean;
}

export type Env = { Variables: { actor: Actor | null; portfolio: RequestPortfolioInfo | null; portfolioWhy?: string } };

/**
 * Resolve the caller from a Bearer API key or the session cookie, and the portfolio the request works in: the key's,
 * or `?portfolio=<slug>` (else the login's only portfolio). The caller's role is their role in that portfolio. Does
 * not reject a request without a portfolio: only touching a portfolio's data does (server/portfolio.ts).
 */
export function resolveActor(via: Via = "api"): MiddlewareHandler<Env> {
  return async (c, next) => {
    const db = getDb();
    const header = c.req.header("authorization");
    const slug = c.req.query("portfolio") || null;
    let actor: Actor | null = null;
    let portfolio: (RequestPortfolioInfo & { id: number }) | null = null;
    let why: string | undefined;
    if (header?.startsWith("Bearer ")) {
      const key = header.slice(7).trim();
      const found = key.startsWith(API_KEY_PREFIX) ? userForApiKey(db, key) : null;
      if (!found) throw new AppError(401, "Invalid API key");
      const k = keyRole(db, found.user.id, found.portfolioId);
      if (k && slug && slug !== k.slug) throw new AppError(403, "This API key works in another portfolio");
      if (k) portfolio = { id: found.portfolioId, slug: k.slug, role: k.role, viewing: false };
      else why = "This API key's owner no longer has access to its portfolio, or it was archived";
      const role = k?.role ?? "viewer";
      actor = {
        user: { ...found.user, role },
        apiKeyId: found.keyId,
        canWrite: !!k && found.scope === "write" && roleCanWrite(role),
        via,
      };
    } else {
      const token = getCookie(c, SESSION_COOKIE);
      const user = token ? userForSession(db, token) : null;
      if (user) {
        // CSRF: cookie-authenticated writes must come from our own origin.
        if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) assertSameOrigin(c);
        const p = portfolioForUser(db, user, slug);
        if (p.id != null) portfolio = { id: p.id, slug: p.slug, role: p.role, viewing: p.viewing };
        else why = p.why;
        const role = portfolio?.role ?? "viewer";
        actor = {
          user: { ...user, role },
          apiKeyId: null,
          canWrite: !!portfolio && !portfolio.viewing && roleCanWrite(role),
          via: "web",
        };
        if (portfolio?.viewing) recordInstanceAdminView(db, actor, portfolio.id);
      }
    }
    c.set("actor", actor);
    c.set("portfolio", portfolio && { slug: portfolio.slug, role: portfolio.role, viewing: portfolio.viewing });
    c.set("portfolioWhy", why);
    // Everything after sign-in runs in the caller's portfolio (server/portfolio.ts); none = no portfolio to see.
    await inRequest(portfolio?.id ?? null, () => next(), why);
  };
}

function assertSameOrigin(c: Context) {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new AppError(403, "Cross-site request blocked");
  const origin = c.req.header("origin");
  if (origin) {
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
    if (new URL(origin).host !== host) throw new AppError(403, "Cross-origin request blocked");
  }
}

export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.get("actor")) throw new AppError(401, "Not signed in");
  await next();
};

export function actorOf(c: Context<Env>): Actor {
  const a = c.get("actor");
  if (!a) throw new AppError(401, "Not signed in");
  return a;
}

export function errorResponse(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json({ error: err.message, details: err.details }, err.status as 400);
  }
  if (err instanceof z.ZodError) {
    return c.json({ error: z.prettifyError(err), issues: err.issues }, 400);
  }
  if (err instanceof SyntaxError && /JSON/.test(err.message)) {
    return c.json({ error: "Malformed JSON body" }, 400);
  }
  log.error({ err }, "unhandled error");
  return c.json({ error: "Internal server error" }, 500);
}

/**
 * The caller's IP for rate limits. X-Forwarded-For is only believed with TRUST_PROXY set, and then only the entries
 * our own proxies appended (counted from the end): anything before them is whatever the client sent.
 */
export function clientIp(c: Context): string {
  if (config.trustProxy > 0) {
    const hops = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ip = hops[hops.length - config.trustProxy];
    if (ip) return ip;
  }
  try {
    return getConnInfo(c).remote.address ?? "local";
  } catch {
    return "local"; // no socket (tests, app.request)
  }
}

// ---- tiny in-memory rate limiter (single instance app) ----
const buckets = new Map<string, { n: number; reset: number }>();
let nextSweep = 0;
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  if (now >= nextSweep) {
    // Drop expired buckets so made-up keys can't grow the map forever.
    for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
    nextSweep = now + 60_000;
  }
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  if (++b.n > max) throw new AppError(429, "Too many attempts; try again later");
}
export function clearRateLimit(key: string) {
  buckets.delete(key);
}
