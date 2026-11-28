import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { and, asc, count, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { DB } from "../db.ts";
import { apiKeys, sessions, users } from "../db/schema.ts";
import { config } from "../config.ts";
import { currentPortfolioId, currentPortfolioIdOrNull, onlyPortfolioId } from "../portfolio.ts";
import { addMember } from "./portfolios.ts";
import {
  AppError,
  audit,
  badRequest,
  notFound,
  requireInstanceAdmin,
  type Actor,
  type Role,
  type User,
} from "../context.ts";

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Checked when there's no user or no password, so a wrong email takes as long as a wrong password. */
let dummyHash: Promise<string> | undefined;

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
    await verifyPassword(password, await dummyHash);
    return false;
  }
  const [algo, n, r, p, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (bytes = 32) => randomBytes(bytes).toString("base64url");

const userCols = {
  id: users.id,
  email: users.email,
  name: users.name,
  // A login has no role of its own: it's the membership's, set per request (http/middleware.ts). Until then a login
  // counts as a viewer; users.role is an unused leftover from before portfolios.
  role: sql<Role>`'viewer'`,
  instance_admin: users.isInstanceAdmin,
};
export interface UserRow extends User {
  password_hash: string | null;
  disabled: boolean;
  oidc_sub: string | null;
}
const userRowCols = {
  ...userCols,
  password_hash: users.passwordHash,
  disabled: users.disabled,
  oidc_sub: users.oidcSub,
};

export function userCount(db: DB): number {
  return db.select({ n: count() }).from(users).get()!.n;
}

export function findUserByEmail(db: DB, email: string): UserRow | undefined {
  return db
    .select(userRowCols)
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
    .get();
}

export function findUserByOidcSub(db: DB, sub: string): UserRow | undefined {
  return db.select(userRowCols).from(users).where(eq(users.oidcSub, sub)).get();
}

export function linkOidcSubject(db: DB, userId: number, sub: string) {
  db.update(users).set({ oidcSub: sub }).where(eq(users.id, userId)).run();
}

export async function setPassword(db: DB, userId: number, password: string) {
  db.update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, userId))
    .run();
}

// ---------- sessions ----------

export function createSession(db: DB, userId: number): { token: string; expires: Date } {
  const t = token();
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  db.insert(sessions)
    .values({ id: sha256(t), userId, expiresAt: expires.toISOString() })
    .run();
  // opportunistic cleanup
  db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString())).run();
  return { token: t, expires };
}

export function userForSession(db: DB, t: string): User | null {
  const row = db
    .select({ ...userCols, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(t)), eq(users.disabled, false)))
    .get();
  if (!row || row.expiresAt < new Date().toISOString()) return null;
  const { expiresAt: _e, ...user } = row;
  return user;
}

export function deleteSession(db: DB, t: string) {
  db.delete(sessions)
    .where(eq(sessions.id, sha256(t)))
    .run();
}

// ---------- API keys ----------

export const API_KEY_PREFIX = "rk_";

/** The key's owner and the portfolio the key works in (whether they may still use it is up to the caller). */
export function userForApiKey(
  db: DB,
  key: string,
): { user: User; keyId: number; scope: "read" | "write"; portfolioId: number } | null {
  const row = db
    .select({ ...userCols, keyId: apiKeys.id, scope: apiKeys.scope, portfolioId: apiKeys.portfolioId })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(apiKeys.keyHash, sha256(key)), isNull(apiKeys.revokedAt), eq(users.disabled, false)))
    .get();
  if (!row) return null;
  db.update(apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(apiKeys.id, row.keyId)).run();
  const { keyId, scope, portfolioId, ...user } = row;
  return { user, keyId, scope, portfolioId };
}

export const apiKeyInput = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(["read", "write"]).default("write"),
});

export function createApiKey(db: DB, actor: Actor, input: z.infer<typeof apiKeyInput>) {
  if (actor.apiKeyId) throw new AppError(403, "API keys cannot create other API keys");
  const prefix = token(6).replace(/[-_]/g, "x").slice(0, 8);
  const key = `${API_KEY_PREFIX}${prefix}_${token(24)}`;
  const { id } = db
    .insert(apiKeys)
    .values({
      userId: actor.user.id,
      portfolioId: currentPortfolioId(db),
      name: input.name,
      prefix,
      keyHash: sha256(key),
      scope: input.scope,
    })
    .returning({ id: apiKeys.id })
    .get();
  audit(db, actor, "create", "api_key", id, { name: input.name, scope: input.scope });
  return { id, key, prefix, name: input.name, scope: input.scope };
}

export function listApiKeys(db: DB, actor: Actor) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scope: apiKeys.scope,
      created_at: apiKeys.createdAt,
      last_used_at: apiKeys.lastUsedAt,
      revoked_at: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, actor.user.id), eq(apiKeys.portfolioId, currentPortfolioId(db))))
    .orderBy(asc(isNotNull(apiKeys.revokedAt)), desc(apiKeys.createdAt))
    .all();
}

export function revokeApiKey(db: DB, actor: Actor, id: number) {
  const r = db
    .update(apiKeys)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(apiKeys.id, id),
        eq(apiKeys.userId, actor.user.id),
        eq(apiKeys.portfolioId, currentPortfolioId(db)),
        isNull(apiKeys.revokedAt),
      ),
    )
    .run();
  if (!r.changes) throw notFound("API key");
  audit(db, actor, "revoke", "api_key", id);
}

// ---------- users ----------

const password = z.string().min(10, "Password must be at least 10 characters").max(200);
export const userCreateInput = z.object({
  email: z.email().trim().toLowerCase(),
  name: z.string().trim().max(100).default(""),
  password: password.optional(),
  role: z.enum(["admin", "member", "viewer"]).default("member"),
});

/**
 * Create a login. It joins the current portfolio at its role. The very first login (setup, or the first OIDC sign-in)
 * runs the server and joins the only portfolio; a login created with no portfolio in scope (an uninvited OIDC
 * sign-in) joins none.
 */
export async function createUser(db: DB, actor: Actor | null, input: z.infer<typeof userCreateInput>) {
  // Portfolio admins add people with invite links; making a login with a password is for the server's administrator.
  if (actor) {
    requireInstanceAdmin(actor);
    // Looking into a portfolio read-only (or a read-only key) doesn't add people to it.
    if (!actor.canWrite) throw new AppError(403, "You can't add people to a portfolio you're only looking at");
  }
  if (findUserByEmail(db, input.email)) throw badRequest("A user with that email already exists");
  const hash = input.password ? await hashPassword(input.password) : null;
  const first = userCount(db) === 0;
  const portfolioId = first ? onlyPortfolioId(db) : actor ? currentPortfolioId(db) : currentPortfolioIdOrNull(db);
  const { id } = db
    .insert(users)
    .values({ email: input.email, name: input.name, passwordHash: hash, isInstanceAdmin: first })
    .returning({ id: users.id })
    .get();
  if (portfolioId != null) addMember(db, actor, portfolioId, id, input.role);
  // The role belongs to the membership (recorded in that portfolio's history), not the login.
  audit(db, actor, "create", "user", id, { email: input.email });
  // with the role it got in the portfolio it joined (a login has none of its own)
  return { ...getUser(db, id), role: portfolioId != null ? input.role : ("viewer" as const) };
}

export function getUser(db: DB, id: number): User {
  const u = db.select(userCols).from(users).where(eq(users.id, id)).get();
  if (!u) throw notFound("User");
  return u;
}

export async function changeOwnPassword(db: DB, actor: Actor, current: string, next: string) {
  const row = db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, actor.user.id)).get();
  if (row?.hash && !(await verifyPassword(current, row.hash))) {
    throw badRequest("Current password is incorrect");
  }
  password.parse(next);
  await setPassword(db, actor.user.id, next);
  audit(db, actor, "change_password", "user", actor.user.id);
}

export function roleCanWrite(role: Role) {
  return role !== "viewer";
}
