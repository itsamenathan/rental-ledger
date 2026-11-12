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
  verifyPassword,
} from "../services/auth.ts";
import { actorOf, clearRateLimit, rateLimit, SESSION_COOKIE, type Env } from "./middleware.ts";

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
authRoutes.post("/setup", async (c) => {
  const db = getDb();
  if (userCount(db) > 0) throw new AppError(403, "Setup already completed");
  const body = z
    .object({ email: z.email(), name: z.string().default(""), password: z.string() })
    .parse(await c.req.json());
  const user = await createUser(db, null, { ...body, role: "admin" });
  startSession(c, user.id);
  return c.json({ user });
});

authRoutes.post("/login", async (c) => {
  if (config.disablePasswordLogin) throw new AppError(403, "Password login is disabled");
  const { email, password } = credentials.parse(await c.req.json());
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  rateLimit(`login:${email}`, 10, 15 * 60_000);
  rateLimit(`login-ip:${ip}`, 30, 15 * 60_000);
  const db = getDb();
  const user = findUserByEmail(db, email);
  const ok = await verifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok || user.disabled) throw new AppError(401, "Invalid email or password");
  clearRateLimit(`login:${email}`);
  startSession(c, user.id);
  audit(db, webActor(user), "login", "user", user.id);
  return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

authRoutes.post("/logout", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) deleteSession(getDb(), token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", (c) => {
  const a = c.get("actor");
  return c.json({ user: a?.user ?? null, can_write: a?.canWrite ?? false, via: a?.via ?? null });
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
  setCookie(c, OIDC_COOKIE, JSON.stringify({ verifier, state, nonce }), {
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
  const { verifier, state, nonce } = JSON.parse(raw) as { verifier: string; state: string; nonce: string };
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
    if (!user && email && claims.email_verified !== false) {
      const byEmail = findUserByEmail(db, email);
      if (byEmail) {
        linkOidcSubject(db, byEmail.id, claims.sub);
        user = byEmail;
      } else if (config.oidc!.autoCreate) {
        const created = await createUser(db, null, {
          email,
          name: typeof claims.name === "string" ? claims.name : "",
          role: userCount(db) === 0 ? "admin" : "member",
        });
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
    return c.redirect("/");
  } catch (e) {
    log.error({ err: e }, "OIDC callback failed");
    return c.redirect("/login?error=" + encodeURIComponent("SSO sign-in failed"));
  }
});
