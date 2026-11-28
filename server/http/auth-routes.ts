import { Hono, type Context } from "hono";
import { log } from "../telemetry.ts";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oidc from "openid-client";
import { z } from "zod";
import { config } from "../config.ts";
import { getDb } from "../db.ts";
import { AppError, audit, type Actor } from "../context.ts";
import {
  changeOwnPassword,
  createSession,
  createUser,
  deleteSession,
  findUserByEmail,
  findUserByOidcSub,
  linkOidcSubject,
  roleCanWrite,
  userCount,
  userCreateInput,
  verifyPassword,
} from "../services/auth.ts";
import { getUserSettings, updateUserSettings } from "../services/user-settings.ts";
import { acceptInviteAs, acceptInviteWithSignup, inviteInfo, useInvite, validInvite } from "../services/invites.ts";
import { getPortfolio, myPortfolios } from "../services/portfolios.ts";
import { currentPortfolioId as inRequestPortfolioId, inRequest } from "../portfolio.ts";
import { tx } from "../db.ts";
import { actorOf, clearRateLimit, clientIp, rateLimit, SESSION_COOKIE, type Env } from "./middleware.ts";

export const authRoutes = new Hono<Env>();

function startSession(c: Context, userId: number) {
  const { token, expires } = createSession(getDb(), userId);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.cookieSecure,
    path: "/",
    expires,
  });
}

const webActor = (user: Actor["user"]): Actor => ({
  user,
  apiKeyId: null,
  canWrite: roleCanWrite(user.role),
  via: "web",
});

authRoutes.get("/config", (c) =>
  c.json({
    needs_setup: userCount(getDb()) === 0,
    password_login: !config.disablePasswordLogin,
    oidc: config.oidc ? { name: config.oidc.name } : null,
  }),
);

const credentials = z.object({ email: z.email().trim().toLowerCase(), password: z.string().min(1).max(200) });

/** First-run: create the initial admin. Only works while no users exist. */
let setupRunning = false;
authRoutes.post("/setup", async (c) => {
  const db = getDb();
  // createUser awaits the password hash between its checks and the insert; one setup at a time keeps it to one admin.
  if (userCount(db) > 0) throw new AppError(403, "Setup already completed");
  const body = userCreateInput.omit({ role: true }).parse(await c.req.json());
  if (!body.password) throw new AppError(400, "Choose a password");
  // No await between this check and taking the flag.
  if (setupRunning || userCount(db) > 0) throw new AppError(403, "Setup already completed");
  setupRunning = true;
  try {
    const user = await createUser(db, null, { ...body, role: "admin" });
    startSession(c, user.id);
    return c.json({ user });
  } finally {
    setupRunning = false;
  }
});

authRoutes.post("/login", async (c) => {
  if (config.disablePasswordLogin) throw new AppError(403, "Password login is disabled");
  const { email, password } = credentials.parse(await c.req.json());
  const ip = clientIp(c);
  // Per email *and* address, so someone guessing elsewhere can't lock the real user out; the per-email cap is only
  // there to slow guessing spread over many addresses.
  rateLimit(`login:${email}:${ip}`, 10, 15 * 60_000);
  rateLimit(`login-ip:${ip}`, 30, 15 * 60_000);
  rateLimit(`login-email:${email}`, 100, 15 * 60_000);
  const db = getDb();
  const user = findUserByEmail(db, email);
  const ok = await verifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok || user.disabled) throw new AppError(401, "Invalid email or password");
  clearRateLimit(`login:${email}:${ip}`);
  startSession(c, user.id);
  audit(db, webActor(user), "login", "user", user.id);
  return c.json({ user: { id: user.id, email: user.email, name: user.name } });
});

authRoutes.post("/logout", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) deleteSession(getDb(), token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", (c) => {
  const a = c.get("actor");
  const db = getDb();
  const p = c.get("portfolio");
  return c.json({
    /** role = the role in this request's portfolio */
    user: a?.user ?? null,
    can_write: a?.canWrite ?? false,
    via: a?.via ?? null,
    settings: a ? getUserSettings(db, a.user.id) : null,
    /** the portfolio this request is in (`?portfolio=<slug>`, else the only one); null with why */
    portfolio: p ? { ...p, name: getPortfolio(db, inRequestPortfolioId(db)).name } : null,
    portfolio_error: p ? null : (c.get("portfolioWhy") ?? null),
    /** every portfolio this login belongs to */
    portfolios: a ? myPortfolios(db, a.user.id).filter((x) => !x.archived) : [],
  });
});

// ---------------- invite links (services/invites.ts) ----------------

/** What an invite link is for, before signing in. */
authRoutes.get("/invites/:token", (c) => c.json(inviteInfo(getDb(), c.req.param("token"))));

/** Join: signed in, with that login; otherwise with a new login (email, name, password). */
authRoutes.post("/invites/:token/accept", async (c) => {
  const db = getDb();
  const token = c.req.param("token");
  const actor = c.get("actor");
  if (actor) {
    if (actor.apiKeyId) throw new AppError(403, "Accept invites from a browser session");
    return c.json(acceptInviteAs(db, token, actor.user.id));
  }
  if (config.disablePasswordLogin) throw new AppError(403, "Password sign-up is disabled; use SSO");
  rateLimit(`invite:${clientIp(c)}`, 20, 15 * 60_000);
  const r = await acceptInviteWithSignup(db, token, await c.req.json());
  startSession(c, r.userId);
  return c.json({ slug: r.slug, portfolio: r.portfolio });
});

/** The caller's own preferences (read-only accounts included: they change nothing in the ledger). */
authRoutes.patch("/settings", async (c) => {
  const actor = actorOf(c);
  if (actor.apiKeyId) throw new AppError(403, "Change your preferences from a browser session");
  return c.json(updateUserSettings(getDb(), actor, await c.req.json().catch(() => null)));
});

authRoutes.post("/password", async (c) => {
  const actor = actorOf(c);
  if (actor.apiKeyId) throw new AppError(403, "Use a browser session to change passwords");
  const body = z.object({ current: z.string().default(""), next: z.string() }).parse(await c.req.json());
  await changeOwnPassword(getDb(), actor, body.current, body.next);
  return c.json({ ok: true });
});

// ---------------- OIDC (e.g. Pocket ID) ----------------

const g = globalThis as unknown as { __oidcConfig?: Promise<oidc.Configuration> };
function oidcConfig() {
  if (!config.oidc) throw new AppError(404, "SSO is not configured");
  g.__oidcConfig ??= oidc
    .discovery(new URL(config.oidc.issuer), config.oidc.clientId, config.oidc.clientSecret)
    .catch((e) => {
      g.__oidcConfig = undefined;
      throw e;
    });
  return g.__oidcConfig;
}

function baseUrl(c: Context) {
  if (config.publicUrl) return config.publicUrl;
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? u.host;
  return `${proto}://${host}`;
}

const OIDC_COOKIE = "rental_oidc";

authRoutes.get("/oidc/start", async (c) => {
  const cfg = await oidcConfig();
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  // An invite link's token rides along, so a new person can sign up with SSO (see the callback).
  const invite = c.req.query("invite")?.slice(0, 100) || undefined;
  setCookie(c, OIDC_COOKIE, JSON.stringify({ verifier, state, nonce, invite }), {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.cookieSecure,
    path: "/api/auth/oidc",
    maxAge: 600,
  });
  const url = oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: `${baseUrl(c)}/api/auth/oidc/callback`,
    scope: "openid email profile",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return c.redirect(url.href);
});

authRoutes.get("/oidc/callback", async (c) => {
  const cfg = await oidcConfig();
  const raw = getCookie(c, OIDC_COOKIE);
  deleteCookie(c, OIDC_COOKIE, { path: "/api/auth/oidc" });
  if (!raw) return c.redirect("/login?error=" + encodeURIComponent("SSO session expired; try again"));
  const { verifier, state, nonce, invite } = JSON.parse(raw) as {
    verifier: string;
    state: string;
    nonce: string;
    invite?: string;
  };
  const current = new URL(c.req.url);
  const callbackUrl = new URL(`${baseUrl(c)}/api/auth/oidc/callback${current.search}`);
  try {
    const tokens = await oidc.authorizationCodeGrant(cfg, callbackUrl, {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("No ID token claims");
    const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
    const db = getDb();
    let user: (Actor["user"] & { disabled: boolean }) | undefined = findUserByOidcSub(db, claims.sub);
    // Only a verified email may claim an existing account: some providers let users type any address.
    if (!user && email && claims.email_verified === true) {
      const byEmail = findUserByEmail(db, email);
      if (byEmail) {
        linkOidcSubject(db, byEmail.id, claims.sub);
        user = byEmail;
      } else if (config.oidc!.autoCreate || (invite && validInvite(db, invite))) {
        // An invite lets a new person sign up with SSO even without OIDC_AUTO_CREATE. Without one, an auto-created
        // login joins no portfolio and sees the "not in a portfolio yet" page.
        // With no portfolio in scope: the request's are those of whatever session this browser still has, and a new
        // login must join only what its invite says.
        const created = await inRequest(null, () =>
          createUser(db, null, {
            email,
            name: typeof claims.name === "string" ? claims.name : "",
            role: userCount(db) === 0 ? "admin" : "member",
          }),
        );
        linkOidcSubject(db, created.id, claims.sub);
        user = { ...created, disabled: false };
      }
    }
    if (!user || user.disabled) {
      return c.redirect(
        "/login?error=" +
          encodeURIComponent(`No active account for ${email ?? "this SSO user"}. Ask an admin to add you.`),
      );
    }
    startSession(c, user.id);
    audit(db, webActor(user), "login_sso", "user", user.id);
    const joined = invite ? validInvite(db, invite) : null;
    if (joined) {
      try {
        tx(db, () => useInvite(db, joined, user.id));
      } catch (e) {
        // Already in that portfolio, or the link was used meanwhile: the invite page says which.
        if (e instanceof AppError) return c.redirect(`/invite/${encodeURIComponent(invite!)}`);
        throw e;
      }
      return c.redirect(`/${joined.slug}`);
    }
    if (invite) return c.redirect(`/invite/${encodeURIComponent(invite)}`);
    return c.redirect("/");
  } catch (e) {
    log.error({ err: e }, "OIDC callback failed");
    return c.redirect("/login?error=" + encodeURIComponent("SSO sign-in failed"));
  }
});
