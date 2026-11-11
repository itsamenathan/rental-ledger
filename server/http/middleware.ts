import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { getDb } from "../db.ts";
import { AppError, type Actor, type Via } from "../context.ts";
import { API_KEY_PREFIX, roleCanWrite, userForApiKey, userForSession } from "../services/auth.ts";

export const SESSION_COOKIE = "rental_session";

export type Env = { Variables: { actor: Actor | null } };

/** Resolve the caller from a Bearer API key or the session cookie. Does not reject. */
export function resolveActor(via: Via = "api"): MiddlewareHandler<Env> {
  return async (c, next) => {
    const db = getDb();
    const header = c.req.header("authorization");
    let actor: Actor | null = null;
    if (header?.startsWith("Bearer ")) {
      const key = header.slice(7).trim();
      const found = key.startsWith(API_KEY_PREFIX) ? userForApiKey(db, key) : null;
      if (!found) throw new AppError(401, "Invalid API key");
      actor = {
        user: found.user,
        apiKeyId: found.keyId,
        canWrite: found.scope === "write" && roleCanWrite(found.user.role),
        via,
      };
    } else {
      const token = getCookie(c, SESSION_COOKIE);
      const user = token ? userForSession(db, token) : null;
      if (user) {
        actor = { user, apiKeyId: null, canWrite: roleCanWrite(user.role), via: "web" };
        // CSRF: cookie-authenticated writes must come from our own origin.
        if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) assertSameOrigin(c);
      }
    }
    c.set("actor", actor);
    await next();
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
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
}

// ---- tiny in-memory rate limiter (single instance app) ----
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
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
