/**
 * Portfolios and who belongs to them (docs/plans/portfolios.md): picking the request's portfolio and role, the
 * members screen (portfolio admins), and the server-wide screens (instance admin: every portfolio and login).
 */
import { and, asc, count, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import {
  apiKeys,
  auditLog,
  categories,
  memberships,
  portfolios,
  receiptExclusions,
  sessions,
  subcategories,
  users,
} from "../db/schema.ts";
import {
  AppError,
  audit,
  badRequest,
  notFound,
  requireAdmin,
  requireInstanceAdmin,
  type Actor,
  type Role,
} from "../context.ts";
import { currentPortfolioId, inPortfolio } from "../portfolio.ts";
import { seedDefaults } from "../seed.ts";
import { createUser, hashPassword } from "./auth.ts";
import { RESERVED_PORTFOLIO_SLUGS, slugProblem, uniqueSlug } from "../slugs.ts";

/** A free web address for a new portfolio with this name (server/slugs.ts). */
export const newSlug = (db: DB, name: string) =>
  uniqueSlug(name, RESERVED_PORTFOLIO_SLUGS, (s) => !!bySlug(db, s), "portfolio");

/** A web address someone typed for portfolio `id`: well formed, not the app's, not another portfolio's. */
const portfolioSlug = z
  .string()
  .trim()
  .toLowerCase()
  .max(64)
  .describe("Web address: /<slug>/… (lowercase letters, numbers, dashes)");
function checkPortfolioSlug(db: DB, id: number, slug: string) {
  const why = slugProblem(slug, RESERVED_PORTFOLIO_SLUGS);
  if (why) throw badRequest(why);
  const other = bySlug(db, slug);
  if (other && other.id !== id) throw badRequest("Another portfolio already uses that web address");
}

export interface PortfolioRef {
  id: number;
  slug: string;
  name: string;
  archived: boolean;
}
const refCols = { id: portfolios.id, slug: portfolios.slug, name: portfolios.name, archived: portfolios.archived };

export function getPortfolio(db: DB, id: number): PortfolioRef {
  const p = db.select(refCols).from(portfolios).where(eq(portfolios.id, id)).get();
  if (!p) throw notFound("Portfolio");
  return p;
}

const bySlug = (db: DB, slug: string) => db.select(refCols).from(portfolios).where(eq(portfolios.slug, slug)).get();

/** The portfolios a login belongs to, with its role in each (active ones first, then by name). */
export function myPortfolios(db: DB, userId: number) {
  return db
    .select({ ...refCols, role: memberships.role })
    .from(memberships)
    .innerJoin(portfolios, eq(portfolios.id, memberships.portfolioId))
    .where(eq(memberships.userId, userId))
    .orderBy(portfolios.archived, sql`lower(${portfolios.name})`)
    .all();
}

export type RequestPortfolio = { id: number; slug: string; role: Role; viewing: boolean } | { id: null; why: string };

/**
 * The portfolio a signed-in person works in for this request: the one named by `?portfolio=<slug>` if they belong to
 * it, else their only active membership. The instance admin may open any portfolio, read-only (`viewing`).
 */
export function portfolioForUser(
  db: DB,
  user: { id: number; instance_admin?: boolean },
  slug?: string | null,
): RequestPortfolio {
  const mine = myPortfolios(db, user.id);
  if (slug) {
    const m = mine.find((p) => p.slug === slug && !p.archived);
    if (m) return { id: m.id, slug: m.slug, role: m.role, viewing: false };
    const p = user.instance_admin ? bySlug(db, slug) : undefined;
    if (p) return { id: p.id, slug: p.slug, role: "viewer", viewing: true };
    return { id: null, why: "You don't have access to this portfolio" };
  }
  const active = mine.filter((p) => !p.archived);
  if (active.length === 1) return { id: active[0]!.id, slug: active[0]!.slug, role: active[0]!.role, viewing: false };
  return {
    id: null,
    why: active.length
      ? "You have access to several portfolios; say which one"
      : "You don't have access to a portfolio yet",
  };
}

/** The key owner's role in the key's portfolio; null when they left it or it was archived. */
export function keyRole(db: DB, userId: number, portfolioId: number): { role: Role; slug: string } | null {
  return (
    db
      .select({ role: memberships.role, slug: portfolios.slug })
      .from(memberships)
      .innerJoin(portfolios, eq(portfolios.id, memberships.portfolioId))
      .where(
        and(eq(memberships.userId, userId), eq(memberships.portfolioId, portfolioId), eq(portfolios.archived, false)),
      )
      .get() ?? null
  );
}

/**
 * The instance admin looked at a portfolio they don't belong to: recorded in that portfolio's audit log, at most once
 * a day per person, so its admins can see it.
 */
export function recordInstanceAdminView(db: DB, actor: Actor, portfolioId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const seen = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.portfolioId, portfolioId),
        eq(auditLog.userId, actor.user.id),
        eq(auditLog.action, "view"),
        gte(auditLog.at, today),
      ),
    )
    .get();
  if (!seen)
    inPortfolio(portfolioId, () => audit(db, actor, "view", "portfolio", portfolioId, { as: "instance admin" }));
}

// ======================= this portfolio =======================

export function currentPortfolio(db: DB) {
  return getPortfolio(db, currentPortfolioId(db));
}

const portfolioName = z.string().trim().min(1, "Name is required").max(100);

/** What changed between two versions of a portfolio, for the audit log. */
const portfolioDiff = (a: PortfolioRef, b: PortfolioRef) =>
  Object.fromEntries(
    (["name", "slug", "archived"] as const).filter((k) => a[k] !== b[k]).map((k) => [k, [a[k], b[k]]]),
  );

/**
 * Rename the current portfolio (its admins) or change its web address (the instance admin: slugs are unique across
 * the server, so "taken" would tell a portfolio admin what other portfolios are called). Renaming keeps the address, so
 * links and bookmarks keep working.
 */
export function renameCurrentPortfolio(db: DB, actor: Actor, raw: unknown) {
  requireAdmin(actor);
  const i = z.object({ name: portfolioName.optional(), slug: portfolioSlug.optional() }).parse(raw);
  const before = currentPortfolio(db);
  if (i.slug != null && i.slug !== before.slug) {
    requireInstanceAdmin(actor);
    checkPortfolioSlug(db, before.id, i.slug);
  }
  if (i.name == null && i.slug == null) return before;
  db.update(portfolios).set({ name: i.name, slug: i.slug }).where(eq(portfolios.id, before.id)).run();
  const after = currentPortfolio(db);
  audit(db, actor, "update", "portfolio", before.id, portfolioDiff(before, after));
  return after;
}

// ======================= members (portfolio admins) =======================

export function listMembers(db: DB, actor: Actor) {
  requireAdmin(actor);
  return db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: memberships.role,
      disabled: users.disabled,
      created_at: memberships.createdAt,
      has_password: sql<boolean>`${users.passwordHash} IS NOT NULL`.mapWith(Boolean),
      has_sso: sql<boolean>`${users.oidcSub} IS NOT NULL`.mapWith(Boolean),
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.portfolioId, currentPortfolioId(db)))
    .orderBy(users.id)
    .all();
}

function membership(db: DB, userId: number) {
  const m = db
    .select({ role: memberships.role, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.userId, userId), eq(memberships.portfolioId, currentPortfolioId(db))))
    .get();
  if (!m) throw notFound("Member");
  return m;
}

/** A portfolio always keeps an admin. */
function assertAnotherAdmin(db: DB, userId: number) {
  const admins = db
    .select({ n: count() })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.portfolioId, currentPortfolioId(db)),
        eq(memberships.role, "admin"),
        eq(users.disabled, false),
        sql`${memberships.userId} <> ${userId}`,
      ),
    )
    .get()!.n;
  if (!admins) throw badRequest("A portfolio needs at least one admin; make someone else an admin first");
}

export const roleInput = z.object({ role: z.enum(["admin", "member", "viewer"]) });

/** Change someone's role in this portfolio. Only the membership changes: the login and its other portfolios don't. */
export function setMemberRole(db: DB, actor: Actor, userId: number, raw: unknown) {
  requireAdmin(actor);
  const { role } = roleInput.parse(raw);
  const before = membership(db, userId);
  if (before.role === role) return { id: userId, role };
  if (before.role === "admin") assertAnotherAdmin(db, userId);
  db.update(memberships)
    .set({ role })
    .where(and(eq(memberships.userId, userId), eq(memberships.portfolioId, currentPortfolioId(db))))
    .run();
  audit(db, actor, "update", "membership", userId, { email: before.email, role: [before.role, role] });
  return { id: userId, role };
}

/** Take someone out of this portfolio: access ends now and their API keys for it stop working. History keeps them. */
export function removeMember(db: DB, actor: Actor, userId: number) {
  requireAdmin(actor);
  return dropMembership(db, actor, userId, false);
}

/** Leave the current portfolio yourself (any role; an admin only if another admin stays). */
export function leaveCurrentPortfolio(db: DB, actor: Actor) {
  if (actor.apiKeyId) throw new AppError(403, "Leave from a browser session");
  return dropMembership(db, actor, actor.user.id, true);
}

function dropMembership(db: DB, actor: Actor, userId: number, left: boolean) {
  const before = membership(db, userId);
  if (before.role === "admin") assertAnotherAdmin(db, userId);
  const pid = currentPortfolioId(db);
  tx(db, () => {
    db.delete(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.portfolioId, pid)))
      .run();
    db.update(apiKeys)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(apiKeys.userId, userId), eq(apiKeys.portfolioId, pid), isNull(apiKeys.revokedAt)))
      .run();
    audit(db, actor, "delete", "membership", userId, {
      email: before.email,
      role: before.role,
      ...(left ? { left } : {}),
    });
  });
  return { removed: before.email };
}

/** Add a login to a portfolio (invites, portfolio creation). Already a member: the role is left alone. */
export function addMember(db: DB, actor: Actor | null, portfolioId: number, userId: number, role: Role) {
  const exists = db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.portfolioId, portfolioId)))
    .get();
  if (exists) return exists.role;
  db.insert(memberships).values({ userId, portfolioId, role }).run();
  const email = db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get()?.email;
  inPortfolio(portfolioId, () => audit(db, actor, "create", "membership", userId, { email, role }));
  return role;
}

// ======================= the whole server (instance admin) =======================

export function listAllPortfolios(db: DB, actor: Actor) {
  requireInstanceAdmin(actor);
  const members = db
    .select({ portfolioId: memberships.portfolioId, n: count() })
    .from(memberships)
    .groupBy(memberships.portfolioId)
    .all();
  return db
    .select({ ...refCols, created_at: portfolios.createdAt })
    .from(portfolios)
    .orderBy(portfolios.archived, sql`lower(${portfolios.name})`)
    .all()
    .map((p) => ({
      ...p,
      members: members.find((m) => m.portfolioId === p.id)?.n ?? 0,
      my_role:
        db
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.portfolioId, p.id), eq(memberships.userId, actor.user.id)))
          .get()?.role ?? null,
    }));
}

export const createPortfolioInput = z.object({
  name: portfolioName,
  /** Start from this portfolio's categories, subcategory rules and never-ask vendors (one the caller belongs to) */
  copy_from: z.string().trim().max(64).optional(),
  /** Make the caller an admin of the new portfolio too */
  join: z.boolean().default(false),
});

/**
 * A new, empty portfolio (instance admin): default categories and a first property, or a copy of another portfolio's
 * categories and receipt rules. Its first admin joins with an invite link (services/invites.ts).
 */
export function createPortfolio(db: DB, actor: Actor, raw: unknown) {
  requireInstanceAdmin(actor);
  const i = createPortfolioInput.parse(raw);
  const source = i.copy_from ? myPortfolios(db, actor.user.id).find((p) => p.slug === i.copy_from) : undefined;
  if (i.copy_from && !source) throw badRequest("Copy from a portfolio you have access to");
  return tx(db, () => {
    const p = db
      .insert(portfolios)
      .values({ name: i.name, slug: newSlug(db, i.name) })
      .returning(refCols)
      .get();
    inPortfolio(p.id, () => audit(db, actor, "create", "portfolio", p.id, { name: i.name, copied_from: source?.name }));
    if (source) copySetup(db, source.id, p.id);
    inPortfolio(p.id, () => seedDefaults(db));
    if (i.join) addMember(db, actor, p.id, actor.user.id, "admin");
    return p;
  });
}

/** Categories (with their subcategories and receipt rules) and never-ask vendors, from one portfolio to another. */
function copySetup(db: DB, fromId: number, toId: number) {
  for (const c of db
    .select()
    .from(categories)
    .where(eq(categories.portfolioId, fromId))
    .orderBy(asc(categories.id))
    .all()) {
    const { id: oldId, portfolioId: _p, ...rest } = c;
    const { id: newId } = db
      .insert(categories)
      .values({ ...rest, portfolioId: toId })
      .returning({ id: categories.id })
      .get();
    for (const s of db.select().from(subcategories).where(eq(subcategories.categoryId, oldId)).all()) {
      const { id: _s, categoryId: _c, createdAt: _t, ...sub } = s;
      db.insert(subcategories)
        .values({ ...sub, categoryId: newId })
        .run();
    }
  }
  for (const e of db.select().from(receiptExclusions).where(eq(receiptExclusions.portfolioId, fromId)).all())
    db.insert(receiptExclusions).values({ portfolioId: toId, name: e.name, note: e.note }).run();
}

export const updatePortfolioInput = z.object({
  name: portfolioName.optional(),
  slug: portfolioSlug.optional(),
  archived: z.boolean().optional(),
});

/** Rename or archive any portfolio (instance admin). Archived: nobody can open it, its API keys stop working. */
export function updatePortfolio(db: DB, actor: Actor, id: number, raw: unknown) {
  requireInstanceAdmin(actor);
  const i = updatePortfolioInput.parse(raw);
  const before = getPortfolio(db, id);
  if (i.archived && !before.archived) {
    const active = db.select({ n: count() }).from(portfolios).where(eq(portfolios.archived, false)).get()!.n;
    if (active <= 1) throw badRequest("Keep at least one portfolio open");
  }
  if (i.slug != null) checkPortfolioSlug(db, id, i.slug);
  if (i.name == null && i.slug == null && i.archived == null) return before;
  db.update(portfolios).set({ name: i.name, slug: i.slug, archived: i.archived }).where(eq(portfolios.id, id)).run();
  const after = getPortfolio(db, id);
  inPortfolio(id, () => audit(db, actor, "update", "portfolio", id, portfolioDiff(before, after)));
  return after;
}

export const createLoginInput = z.object({
  email: z.email().trim().toLowerCase(),
  name: z.string().trim().max(100).default(""),
  password: z.string().min(10, "Password must be at least 10 characters").max(200).optional(),
  role: z.enum(["admin", "member", "viewer"]).default("member"),
  portfolio_id: z.number().int().positive(),
});

/**
 * A login with a password, made by the server's administrator, joining one portfolio (everyone else joins by invite).
 * Audited in that portfolio.
 */
export async function createLogin(db: DB, actor: Actor, raw: unknown) {
  requireInstanceAdmin(actor);
  const { portfolio_id, ...input } = createLoginInput.parse(raw);
  const p = getPortfolio(db, portfolio_id);
  if (p.archived) throw badRequest("That portfolio is archived");
  // A server-level action: it doesn't depend on the role the administrator has (or lacks) in that portfolio.
  const user = await inPortfolio(p.id, () => createUser(db, { ...actor, canWrite: true }, input));
  return listLogins(db, actor).find((u) => u.id === user.id)!;
}

/** Every login on the server with the portfolios it belongs to (instance admin). */
export function listLogins(db: DB, actor: Actor) {
  requireInstanceAdmin(actor);
  const rows = db
    .select({ userId: memberships.userId, slug: portfolios.slug, name: portfolios.name, role: memberships.role })
    .from(memberships)
    .innerJoin(portfolios, eq(portfolios.id, memberships.portfolioId))
    .all();
  return db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      instance_admin: users.isInstanceAdmin,
      disabled: users.disabled,
      created_at: users.createdAt,
      has_password: sql<boolean>`${users.passwordHash} IS NOT NULL`.mapWith(Boolean),
      has_sso: sql<boolean>`${users.oidcSub} IS NOT NULL`.mapWith(Boolean),
    })
    .from(users)
    .orderBy(users.id)
    .all()
    .map((u) => ({
      ...u,
      portfolios: rows.filter((r) => r.userId === u.id).map(({ userId: _u, ...r }) => r),
    }));
}

const password = z.string().min(10, "Password must be at least 10 characters").max(200);
export const loginUpdateInput = z.object({
  name: z.string().trim().max(100).optional(),
  disabled: z.boolean().optional(),
  password: password.optional(),
  instance_admin: z.boolean().optional(),
});

/**
 * Change a login itself (instance admin): name, password, disabled, server administrator. These reach every portfolio
 * the person belongs to, which is why a portfolio's own admins can't.
 */
export async function updateLogin(db: DB, actor: Actor, id: number, raw: unknown) {
  tx(db, await prepareLoginUpdate(db, actor, id, raw));
  return listLogins(db, actor).find((u) => u.id === id)!;
}

/**
 * Check a login change and hash its password (the slow, async part); the returned function makes the change and is
 * synchronous, so a caller can run it in one transaction with other writes.
 */
async function prepareLoginUpdate(db: DB, actor: Actor, id: number, raw: unknown): Promise<() => void> {
  requireInstanceAdmin(actor);
  const i = loginUpdateInput.parse(raw);
  const before = db.select({ email: users.email }).from(users).where(eq(users.id, id)).get();
  if (!before) throw notFound("User");
  if (id === actor.user.id && (i.disabled || i.instance_admin === false))
    throw badRequest("You cannot disable your own login or stop being the server's administrator");
  const passwordHash = i.password ? await hashPassword(i.password) : undefined;
  return () => {
    if (i.disabled) {
      // A portfolio always keeps an admin who can sign in: name the ones this login is the last enabled admin of.
      const alone = db
        .select({ name: portfolios.name })
        .from(memberships)
        .innerJoin(portfolios, eq(portfolios.id, memberships.portfolioId))
        .where(
          and(
            eq(memberships.userId, id),
            eq(memberships.role, "admin"),
            eq(portfolios.archived, false),
            sql`not exists (select 1 from ${memberships} m join ${users} u on u.id = m.user_id
              where m.portfolio_id = ${memberships.portfolioId} and m.role = 'admin' and u.disabled = 0
              and m.user_id <> ${id})`,
          ),
        )
        .all();
      if (alone.length)
        throw badRequest(
          `${before.email} is the only admin of ${alone.map((p) => p.name).join(", ")}. Give it another admin ` +
            `first (All portfolios → Admin invite link).`,
        );
    }
    const changes = Object.fromEntries(
      Object.entries({ name: i.name, disabled: i.disabled, passwordHash, isInstanceAdmin: i.instance_admin }).filter(
        ([, v]) => v !== undefined,
      ),
    );
    if (Object.keys(changes).length) db.update(users).set(changes).where(eq(users.id, id)).run();
    if (i.disabled) db.delete(sessions).where(eq(sessions.userId, id)).run();
    const { password: _p, ...logged } = i;
    audit(db, actor, "update", "user", id, { ...logged, password_changed: !!i.password, email: before.email });
  };
}

/** Make a login the server's administrator (the CLI's way back in when no administrator can sign in). */
export function makeInstanceAdmin(db: DB, userId: number) {
  const u = db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get();
  if (!u) throw notFound("User");
  db.update(users).set({ isInstanceAdmin: true, disabled: false }).where(eq(users.id, userId)).run();
  audit(db, null, "update", "user", userId, { email: u.email, instance_admin: true, disabled: false });
}

/**
 * A person on this portfolio's People page: `role` is their membership here (its admins); any other field changes
 * the login itself (the server's administrator). Both change or neither does.
 */
export async function updateMember(db: DB, actor: Actor, id: number, raw: unknown) {
  // Not while only looking in: the server's administrator changes logins under Server → Logins.
  if (!actor.canWrite) throw new AppError(403, "This account or API key is read-only");
  const { role, ...login } = (raw ?? {}) as Record<string, unknown>;
  const applyLogin = Object.keys(login).length ? await prepareLoginUpdate(db, actor, id, login) : null;
  tx(db, () => {
    if (role !== undefined) setMemberRole(db, actor, id, { role });
    applyLogin?.();
  });
  return listMembers(db, actor).find((m) => m.id === id) ?? { id };
}
