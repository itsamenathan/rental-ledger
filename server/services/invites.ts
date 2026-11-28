/**
 * Invite links: how people join a portfolio. A portfolio admin makes a link with a role and sends it however they
 * like; whoever opens it signs up (password or SSO) or, already signed in, joins with the login they have. Only a
 * hash of the token is stored; a link works once, expires after INVITE_DAYS and can be revoked.
 *
 * An invite never attaches to an existing login by email: the person has to be signed in as that login to accept.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { invites, memberships, portfolios, users } from "../db/schema.ts";
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
import { findUserByEmail, getUser, hashPassword, sha256 } from "./auth.ts";
import { addMember, getPortfolio } from "./portfolios.ts";

export const INVITE_DAYS = 7;

export const inviteInput = z.object({
  role: z.enum(["admin", "member", "viewer"]).default("member"),
  note: z.string().trim().max(200).default("").describe("Who it's for, e.g. their name or email (not checked)"),
});

const listCols = {
  id: invites.id,
  role: invites.role,
  note: invites.note,
  created_at: invites.createdAt,
  expires_at: invites.expiresAt,
  accepted_at: invites.acceptedAt,
  revoked_at: invites.revokedAt,
  created_by: users.email,
};

function insertInvite(db: DB, actor: Actor, portfolioId: number, role: Role, note: string) {
  const token = randomBytes(24).toString("base64url");
  const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString();
  const { id } = db
    .insert(invites)
    .values({ portfolioId, tokenHash: sha256(token), role, note, createdBy: actor.user.id, expiresAt: expires })
    .returning({ id: invites.id })
    .get();
  inPortfolio(portfolioId, () => audit(db, actor, "create", "invite", id, { role, note }));
  return { id, token, path: `/invite/${token}`, role, note, expires_at: expires };
}

/** A link to join the current portfolio (its admins). */
export function createInvite(db: DB, actor: Actor, raw: unknown) {
  requireAdmin(actor);
  if (actor.apiKeyId) throw new AppError(403, "Invite people from a browser session");
  const i = inviteInput.parse(raw);
  return insertInvite(db, actor, currentPortfolioId(db), i.role, i.note);
}

/** A link to any portfolio (instance admin): how a new portfolio gets its first admin. */
export function createInviteFor(db: DB, actor: Actor, portfolioId: number, raw: unknown) {
  requireInstanceAdmin(actor);
  getPortfolio(db, portfolioId);
  const i = inviteInput.parse(raw);
  return insertInvite(db, actor, portfolioId, i.role, i.note);
}

/** Links of the current portfolio that are still waiting (not used, not revoked), newest first. */
export function listInvites(db: DB, actor: Actor) {
  requireAdmin(actor);
  const now = new Date().toISOString();
  return db
    .select(listCols)
    .from(invites)
    .leftJoin(users, eq(users.id, invites.createdBy))
    .where(and(eq(invites.portfolioId, currentPortfolioId(db)), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
    .orderBy(desc(invites.id))
    .all()
    .map((r) => ({ ...r, expired: r.expires_at < now }));
}

export function revokeInvite(db: DB, actor: Actor, id: number) {
  requireAdmin(actor);
  const r = db
    .update(invites)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(invites.id, id), eq(invites.portfolioId, currentPortfolioId(db)), isNull(invites.revokedAt)))
    .run();
  if (!r.changes) throw notFound("Invite");
  audit(db, actor, "revoke", "invite", id);
  return { ok: true };
}

type FoundInvite = {
  id: number;
  portfolioId: number;
  role: Role;
  expiresAt: string;
  portfolio: string;
  slug: string;
};

/** A usable invite for this token, or why not. */
function findInvite(db: DB, token: string): { error: string } | { invite: FoundInvite } {
  const row = db
    .select({
      id: invites.id,
      portfolioId: invites.portfolioId,
      role: invites.role,
      expiresAt: invites.expiresAt,
      acceptedAt: invites.acceptedAt,
      revokedAt: invites.revokedAt,
      portfolio: portfolios.name,
      slug: portfolios.slug,
      archived: portfolios.archived,
    })
    .from(invites)
    .innerJoin(portfolios, eq(portfolios.id, invites.portfolioId))
    .where(eq(invites.tokenHash, sha256(token)))
    .get();
  if (!row) return { error: "This invite link isn't valid. Ask for a new one." };
  if (row.acceptedAt) return { error: "This invite link was already used. Ask for a new one." };
  if (row.revokedAt || row.archived) return { error: "This invite link was cancelled. Ask for a new one." };
  if (row.expiresAt < new Date().toISOString()) return { error: "This invite link has expired. Ask for a new one." };
  return { invite: row };
}

/** What the invite page shows before anyone signs in. */
export function inviteInfo(db: DB, token: string) {
  const f = findInvite(db, token);
  if ("error" in f) return { valid: false as const, error: f.error };
  return { valid: true as const, portfolio: f.invite.portfolio, role: f.invite.role, expires_at: f.invite.expiresAt };
}

/** The person joining, recorded as doing it themselves (always from a browser: the invite page or SSO sign-up). */
const joiner = (db: DB, userId: number): Actor => ({
  user: getUser(db, userId),
  apiKeyId: null,
  canWrite: false,
  via: "web",
});

function use(db: DB, invite: { id: number; portfolioId: number; role: Role }, userId: number) {
  // Kept for someone else (and no role changes by invite: an admin changes roles on the People page).
  const member = db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.portfolioId, invite.portfolioId)))
    .get();
  if (member) throw badRequest("You already have access to this portfolio. The invite link is still unused.");
  // Claimed in the same statement that checks it's unused, so two clicks can't both join.
  const r = db
    .update(invites)
    .set({ acceptedAt: new Date().toISOString(), acceptedBy: userId })
    .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
    .run();
  if (!r.changes) throw badRequest("This invite link was already used. Ask for a new one.");
  return addMember(db, joiner(db, userId), invite.portfolioId, userId, invite.role);
}

/** Join with the login you're signed in as. */
export function acceptInviteAs(db: DB, token: string, userId: number) {
  const f = findInvite(db, token);
  if ("error" in f) throw badRequest(f.error);
  tx(db, () => use(db, f.invite, userId));
  return { slug: f.invite.slug, portfolio: f.invite.portfolio };
}

const password = z.string().min(10, "Password must be at least 10 characters").max(200);
export const signupInput = z.object({
  email: z.email().trim().toLowerCase(),
  name: z.string().trim().max(100).default(""),
  password,
});

/**
 * Join with a new login (email + password). An email that already has a login has to sign in and accept instead,
 * so a link can't be used to take over someone's account.
 */
export async function acceptInviteWithSignup(db: DB, token: string, raw: unknown) {
  const i = signupInput.parse(raw);
  const first = findInvite(db, token);
  if ("error" in first) throw badRequest(first.error);
  const hash = await hashPassword(i.password);
  return tx(db, () => {
    const f = findInvite(db, token); // again: the hash was awaited
    if ("error" in f) throw badRequest(f.error);
    if (findUserByEmail(db, i.email))
      throw badRequest("That email already has a login here: sign in with it, then open this link again.");
    const user = db
      .insert(users)
      .values({ email: i.email, name: i.name, passwordHash: hash })
      .returning({ id: users.id })
      .get();
    inPortfolio(f.invite.portfolioId, () =>
      audit(db, joiner(db, user.id), "create", "user", user.id, { email: i.email, via_invite: f.invite.id }),
    );
    use(db, f.invite, user.id);
    return { userId: user.id, slug: f.invite.slug, portfolio: f.invite.portfolio };
  });
}

/** For SSO sign-up: the invite's role, if the token is still good (the login is made in the OIDC callback). */
export function validInvite(db: DB, token: string) {
  const f = findInvite(db, token);
  return "invite" in f ? f.invite : null;
}
export { use as useInvite };
