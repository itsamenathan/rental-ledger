/**
 * Portfolios (several properties together) and the people in them: the switcher, the invite page, the "not in a portfolio" page,
 * the portfolio pages in Settings (Portfolio, People & invites) and the Server pages (the server's administrator:
 * every portfolio and login). See docs/plans/portfolios.md.
 */
import { useState, type FormEvent } from "react";
import { Navigate, useParams } from "react-router";
import { api, type Me, type PortfolioRef, type Role } from "../api.ts";
import { useApi, useConfirm, useSession, useToast } from "../hooks.ts";
import { apiUrl, forgetPortfolio, movePortfolio, openPortfolio, PORTFOLIO_SLUG } from "../portfolio.ts";
import { fmtDate } from "../format.ts";
import { Modal } from "../lib.tsx";
import { slugTyping } from "../../server/slugs.ts";

const ROLE_LABEL: Record<Role, string> = {
  admin: "admin",
  member: "member",
  viewer: "viewer (read-only, e.g. your accountant)",
};

const inviteUrl = (path: string) => `${location.origin}${path}`;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ======================= in the shell =======================

/** The server's administrator looking at someone else's portfolio. */
export function ViewingBanner() {
  const { portfolio } = useSession();
  if (!portfolio.viewing) return null;
  return (
    <div className="alert warn viewing-banner">
      You're looking at <strong>{portfolio.name}</strong> as the server's administrator: read-only, and noted in its
      change history.
    </div>
  );
}

// ======================= outside a portfolio =======================

/** Signed in, but this address's portfolio isn't one of theirs, or they have none yet. */
export function NoPortfolio({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const mine = (me.portfolios ?? []).filter((p) => !p.archived);
  const admin = !!me.user?.instance_admin;
  const signOut = async () => {
    await api("auth/logout", { method: "POST" });
    await globalThis.caches?.delete("api-v1").catch(() => false);
    onLogout();
  };
  return (
    <div className="login">
      <div className="card login-card wide">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>Rental Ledger</span>
        </div>
        {PORTFOLIO_SLUG && mine.length ? (
          <>
            <h1>You don't have access to this portfolio</h1>
            <p className="muted">Open one of yours instead:</p>
            <PortfolioLinks portfolios={mine} />
          </>
        ) : (
          <>
            <h1>You don't have access to a portfolio yet</h1>
            <p className="muted">
              Signed in as {me.user?.email}. Ask whoever runs this server or the portfolio you need for an invite link.
            </p>
          </>
        )}
        {admin && <ServerPortfolios standalone />}
        <button className="link" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}

function PortfolioLinks({ portfolios }: { portfolios: PortfolioRef[] }) {
  return (
    <ul className="portfolio-links">
      {portfolios.map((p) => (
        <li key={p.slug}>
          <a href={`/${p.slug}`}>{p.name}</a> <span className="muted small">{p.role}</span>
        </li>
      ))}
    </ul>
  );
}

interface InviteInfo {
  valid: boolean;
  error?: string;
  portfolio?: string;
  role?: Role;
  expires_at?: string;
}

/** /invite/<token>: join a portfolio, signed in (with that login) or by making a login. */
export function InvitePage() {
  const { token = "" } = useParams();
  const info = useApi<InviteInfo>(`/api/auth/invites/${encodeURIComponent(token)}`);
  const me = useApi<Me>("/api/auth/me");
  const cfg = useApi<{ password_login: boolean; oidc: { name: string } | null }>("/api/auth/config");
  const [form, setForm] = useState({ email: "", name: "", password: "" });
  const [error, setError] = useState<string | null>(() => new URLSearchParams(location.search).get("error"));
  const [busy, setBusy] = useState(false);
  if (!info.data || !me.data || !cfg.data) return <div className="boot">Loading…</div>;
  const accept = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ slug: string }>(`/api/auth/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        json: me.data?.user ? {} : form,
      });
      openPortfolio(r.slug);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const user = me.data.user;
  return (
    <div className="login">
      <div className="card login-card">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>Rental Ledger</span>
        </div>
        {!info.data.valid ? (
          <>
            <h1>Invite link</h1>
            <div className="alert error">{info.data.error}</div>
            <a className="btn block" href="/">
              Go to the app
            </a>
          </>
        ) : (
          <>
            <h1>Join {info.data.portfolio}</h1>
            <p className="muted">
              You're invited as {info.data.role === "viewer" ? "a viewer (read-only)" : `a ${info.data.role}`}. The link
              works once, until {fmtDate(info.data.expires_at!.slice(0, 10))}.
            </p>
            {error && <div className="alert error">{error}</div>}
            {user ? (
              <>
                <p>
                  Signed in as <strong>{user.email}</strong>.
                </p>
                <button className="btn primary block" disabled={busy} onClick={() => void accept()}>
                  {busy ? "…" : `Join ${info.data.portfolio}`}
                </button>
                <p className="muted small">
                  Not you?{" "}
                  <button
                    className="link"
                    onClick={() =>
                      void api("/api/auth/logout", { method: "POST" })
                        .then(() => globalThis.caches?.delete("api-v1"))
                        .finally(() => location.reload())
                    }
                  >
                    Sign out
                  </button>{" "}
                  and join with another login.
                </p>
              </>
            ) : (
              <>
                {cfg.data.oidc && (
                  <>
                    <a className="btn primary block" href={`/api/auth/oidc/start?invite=${encodeURIComponent(token)}`}>
                      Continue with {cfg.data.oidc.name}
                    </a>
                    {cfg.data.password_login && <div className="divider">or make a login</div>}
                  </>
                )}
                {cfg.data.password_login && (
                  <form onSubmit={accept}>
                    <label>
                      Name
                      <input
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        autoComplete="name"
                      />
                    </label>
                    <label>
                      Email
                      <input
                        type="email"
                        required
                        value={form.email}
                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                        autoComplete="username"
                      />
                    </label>
                    <label>
                      Password
                      <input
                        type="password"
                        required
                        minLength={10}
                        value={form.password}
                        onChange={(e) => setForm({ ...form, password: e.target.value })}
                        autoComplete="new-password"
                      />
                    </label>
                    <button className="btn primary block" disabled={busy}>
                      {busy ? "…" : "Create login and join"}
                    </button>
                    <p className="muted small">
                      Already have a login here?{" "}
                      <a href={`/?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in</a> and you'll come back here
                      to join.
                    </p>
                  </form>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ======================= Settings → this portfolio =======================

interface Member {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  has_password: boolean;
  has_sso: boolean;
}
interface Invite {
  id: number;
  role: Role;
  note: string;
  created_at: string;
  expires_at: string;
  created_by: string | null;
  expired: boolean;
}

/** Settings → Portfolio → General: what this portfolio holds, and its name (admins rename). */
export function PortfolioGeneral() {
  const { user, portfolio, portfolios, overview } = useSession();
  const admin = user.role === "admin" && !portfolio.viewing;
  // Web addresses are unique across the server, so only its administrator changes them (server/services/portfolios.ts).
  const instanceAdmin = !!user.instance_admin && !portfolio.viewing;
  const [name, setName] = useState(portfolio.name);
  const [slug, setSlug] = useState(portfolio.slug);
  const toast = useToast();
  const confirm = useConfirm();
  const leave = async () => {
    if (
      !(await confirm({
        title: `Leave ${portfolio.name}?`,
        message:
          "You lose access straight away and your API keys for this portfolio stop working. To come back, someone with admin access has to invite you again.",
        confirm: "Leave",
        danger: true,
      }))
    )
      return;
    try {
      await api("portfolio/membership", { method: "DELETE" });
      forgetPortfolio();
      location.assign("/");
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const json = {
        ...(name.trim() !== portfolio.name ? { name } : {}),
        ...(slug !== portfolio.slug ? { slug } : {}),
      };
      const saved = await api<PortfolioRef>("portfolio", { method: "PATCH", json });
      // The name shows in the switcher and Settings; a new address means a new page.
      if (saved.slug !== portfolio.slug) {
        movePortfolio(portfolio.slug, saved.slug);
        openPortfolio(saved.slug, "/settings/portfolio");
      } else location.reload();
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  const active = overview.properties.filter((p) => !p.archived).length;
  return (
    <>
      <form className="card" onSubmit={rename}>
        <h2>{portfolio.name}</h2>
        <p className="muted">
          {active} {active === 1 ? "property" : "properties"} with their own categories, receipt rules, people and
          change history. Other portfolios on this server are kept completely apart.
          {portfolios.filter((p) => !p.archived).length > 1 && " Switch between yours with the picker in the sidebar."}
        </p>
        <p className="muted small">Your role here: {portfolio.viewing ? "looking in (read-only)" : user.role}.</p>
        {admin && (
          <>
            <div className="row-2">
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
              </label>
              {instanceAdmin && (
                <label>
                  Web address
                  <span className="slug-input">
                    <span className="muted">{location.host}/</span>
                    <input
                      value={slug}
                      onChange={(e) => setSlug(slugTyping(e.target.value))}
                      required
                      pattern="[a-z0-9]+(-[a-z0-9]+)*"
                      title="Lowercase letters, numbers and dashes"
                      maxLength={40}
                    />
                  </span>
                </label>
              )}
            </div>
            <p className="muted small">
              Renaming keeps the web address
              {instanceAdmin && ". Bookmarks and links to the old address stop working when it changes"}.
            </p>
            <button
              className="btn"
              disabled={!name.trim() || (name.trim() === portfolio.name && slug === portfolio.slug)}
            >
              Save
            </button>
          </>
        )}
      </form>
      {!portfolio.viewing && (
        <section className="card">
          <h2>Leave this portfolio</h2>
          <p className="muted">
            Stop having access to {portfolio.name}. Nothing in it changes.
            {user.role === "admin" && " If you're the only admin, make someone else an admin first."}
          </p>
          <button className="btn danger" onClick={() => void leave()}>
            Leave {portfolio.name}
          </button>
        </section>
      )}
    </>
  );
}

/** Settings → Download: everything in this portfolio as one zip (anyone who can open it). */
export function DownloadPortfolio() {
  const { portfolio } = useSession();
  return (
    <section className="card">
      <h2>Download everything</h2>
      <p className="muted">
        One zip with all of {portfolio.name}: every transaction, property, category, occupancy month, owner stay and
        tax-year input as spreadsheets (CSV), plus every receipt and manager statement as files. Keep it as your own
        copy, or take your data elsewhere.
      </p>
      <a className="btn primary" href={apiUrl("/api/export/portfolio.zip")} download>
        Download everything (.zip)
      </a>
      <p className="muted small">
        Just the transactions?{" "}
        <a href={apiUrl("/api/export/transactions.csv?property=all")} download>
          Download them as CSV
        </a>
        .
      </p>
    </section>
  );
}

/** Settings → People & invites: this portfolio's members and invite links (its admins). */
export function People() {
  const { user, portfolio } = useSession();
  const admin = user.role === "admin" && !portfolio.viewing;
  const members = useApi<Member[]>(admin ? "users" : null);
  const pending = useApi<Invite[]>(admin ? "invites" : null);
  const [invite, setInvite] = useState<{ role: Role; note: string }>({ role: "member", note: "" });
  const [made, setMade] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  if (!admin) return <Navigate to="/settings" replace />;
  const fail = (err: unknown) => toast({ text: (err as Error).message, kind: "error" });

  const setRole = async (m: Member, role: string) => {
    try {
      await api(`users/${m.id}`, { method: "PATCH", json: { role } });
      void members.reload();
    } catch (err) {
      fail(err);
    }
  };
  const remove = async (m: Member) => {
    if (
      !(await confirm({
        title: `Remove ${m.name || m.email}?`,
        message: `They lose access to ${portfolio.name} straight away and their API keys for it stop working. Their login and any other portfolios they're in stay.`,
        confirm: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      await api(`users/${m.id}`, { method: "DELETE" });
      void members.reload();
      toast({ text: `${m.email} removed`, kind: "ok" });
    } catch (err) {
      fail(err);
    }
  };
  const makeInvite = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ path: string }>("invites", { method: "POST", json: invite });
      const url = inviteUrl(r.path);
      setMade(url);
      setInvite({ role: "member", note: "" });
      void pending.reload();
      if (await copy(url)) toast({ text: "Invite link copied", kind: "ok" });
    } catch (err) {
      fail(err);
    }
  };
  const revoke = async (i: Invite) => {
    try {
      await api(`invites/${i.id}`, { method: "DELETE" });
      void pending.reload();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <>
      <section className="card table-card">
        <h2>Who has access</h2>
        <p className="muted card-pad-x">
          Members add and fix entries, viewers only look (good for an accountant), admins also manage who has access.
          {` Roles apply to ${portfolio.name} only; someone's password and sign-in belong to their login, which can be in other portfolios too.`}
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role here</th>
              <th>Sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.data?.map((m) => (
              <tr key={m.id} className={m.disabled ? "excluded" : ""}>
                <td>{m.email}</td>
                <td>{m.name}</td>
                <td>
                  <select
                    value={m.role}
                    onChange={(e) => void setRole(m, e.target.value)}
                    disabled={m.id === user.id}
                    aria-label="Role"
                  >
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                    <option value="viewer">viewer (read-only)</option>
                  </select>
                </td>
                <td>
                  {m.disabled
                    ? "disabled"
                    : [m.has_password ? "password" : null, m.has_sso ? "SSO" : null].filter(Boolean).join(", ") || "—"}
                </td>
                <td>
                  {m.id !== user.id && (
                    <button className="link" onClick={() => void remove(m)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form className="card" onSubmit={makeInvite}>
        <h2>Invite someone</h2>
        <p className="muted">
          Makes a link that works once, for 7 days. Send it however you like; they make a login (or sign in with the one
          they have) and join {portfolio.name}.
        </p>
        <div className="row-2">
          <label>
            Role
            <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value as Role })}>
              {(["member", "viewer", "admin"] as const).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <label>
            For (optional note)
            <input
              value={invite.note}
              onChange={(e) => setInvite({ ...invite, note: e.target.value })}
              placeholder="e.g. Sam, our accountant"
              maxLength={200}
            />
          </label>
        </div>
        <button className="btn primary">Make invite link</button>
        {made && (
          <div className="alert ok invite-made">
            <input readOnly value={made} onFocus={(e) => e.target.select()} aria-label="Invite link" />
            <button
              type="button"
              className="btn"
              onClick={() => void copy(made).then((ok) => ok && toast({ text: "Copied", kind: "ok" }))}
            >
              Copy
            </button>
          </div>
        )}
        {!!pending.data?.length && (
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Waiting</th>
                <th>Role</th>
                <th>Made</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.data.map((i) => (
                <tr key={i.id} className={i.expired ? "excluded" : ""}>
                  <td>{i.note || "—"}</td>
                  <td>{i.role}</td>
                  <td>
                    {fmtDate(i.created_at.slice(0, 10))}
                    {i.expired ? " (expired)" : ""}
                  </td>
                  <td>
                    <button type="button" className="link" onClick={() => void revoke(i)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </form>
    </>
  );
}

// ======================= Settings → Server (its administrator) =======================

interface ServerPortfolio {
  id: number;
  slug: string;
  name: string;
  archived: boolean;
  members: number;
  my_role: Role | null;
}
interface Login {
  id: number;
  email: string;
  name: string;
  instance_admin: boolean;
  disabled: boolean;
  has_password: boolean;
  has_sso: boolean;
  portfolios: { slug: string; name: string; role: Role }[];
}

/** Said once at the top of every Server page. */
export function ServerNote() {
  return (
    <div className="alert server-note">
      Only you see these pages: they're about the whole server and everyone on it, not one portfolio.
    </div>
  );
}

/** Server → Portfolios: every portfolio on the server; make new ones. */
export function ServerPortfolios({ standalone = false }: { standalone?: boolean }) {
  const list = useApi<ServerPortfolio[]>("/api/admin/portfolios");
  const [form, setForm] = useState({ name: "", copy_from: "", join: true });
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const fail = (err: unknown) => toast({ text: (err as Error).message, kind: "error" });
  const mine = list.data?.filter((p) => p.my_role) ?? [];

  const firstAdminLink = async (p: { id: number; name: string }) => {
    try {
      const r = await api<{ path: string }>(`/api/admin/portfolios/${p.id}/invites`, {
        method: "POST",
        json: { role: "admin", note: "first admin" },
      });
      const url = inviteUrl(r.path);
      setLink({ name: p.name, url });
      if (await copy(url)) toast({ text: "Admin invite link copied", kind: "ok" });
    } catch (err) {
      fail(err);
    }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await api<ServerPortfolio>("/api/admin/portfolios", {
        method: "POST",
        json: { name: form.name, copy_from: form.copy_from || undefined, join: form.join },
      });
      setForm({ name: "", copy_from: "", join: true });
      void list.reload();
      toast({ text: `${p.name} created`, kind: "ok" });
      if (!form.join) await firstAdminLink(p);
    } catch (err) {
      fail(err);
    }
  };
  const archive = async (p: ServerPortfolio) => {
    if (
      !p.archived &&
      !(await confirm({
        title: `Archive ${p.name}?`,
        message: "Nobody can open it until it's unarchived, and its API keys stop working. Nothing is deleted.",
        confirm: "Archive",
        danger: true,
      }))
    )
      return;
    try {
      await api(`/api/admin/portfolios/${p.id}`, { method: "PATCH", json: { archived: !p.archived } });
      void list.reload();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <>
      <section className={standalone ? "" : "card table-card"}>
        <h2>All portfolios on this server</h2>
        <p className={`muted ${standalone ? "" : "card-pad-x"}`}>
          Each is one person's or household's properties, kept apart from the others. Open one you're not in to look
          around read-only; the visit is noted in its change history.
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>People</th>
              <th>You</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data?.map((p) => (
              <tr key={p.id} className={p.archived ? "excluded" : ""}>
                <td>
                  {p.archived ? p.name : <a href={`/${p.slug}`}>{p.name}</a>}
                  {p.archived && " (archived)"}
                  {p.slug === PORTFOLIO_SLUG && <span className="muted small"> (this one)</span>}
                </td>
                <td>{p.members}</td>
                <td>{p.my_role ?? "not a member"}</td>
                <td className="row-actions">
                  {!p.archived && (
                    <button className="link" onClick={() => void firstAdminLink(p)}>
                      Admin invite link
                    </button>
                  )}
                  {p.slug !== PORTFOLIO_SLUG && (
                    <button className="link" onClick={() => void archive(p)}>
                      {p.archived ? "Unarchive" : "Archive"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {link && (
          <div className="alert ok invite-made">
            <span>Send this to {link.name}'s first admin (works once, for 7 days):</span>
            <input readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Invite link" />
          </div>
        )}
      </section>

      <form className={standalone ? "" : "card"} onSubmit={create}>
        <h2>New portfolio</h2>
        <div className="row-2">
          <label>
            Name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              maxLength={100}
              placeholder="e.g. Jordan's rentals"
            />
          </label>
          <label>
            Start with
            <select value={form.copy_from} onChange={(e) => setForm({ ...form, copy_from: e.target.value })}>
              <option value="">The default categories</option>
              {mine.map((p) => (
                <option key={p.slug} value={p.slug}>
                  Categories and receipt rules of {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.join} onChange={(e) => setForm({ ...form, join: e.target.checked })} />
          Make me an admin of it (otherwise you get an invite link for its first admin)
        </label>
        <button className="btn primary">Create portfolio</button>
      </form>
    </>
  );
}

/** Server → Logins: every login; password, disable, and adding one with a password. */
export function ServerLogins() {
  const logins = useApi<Login[]>("/api/admin/users");
  const list = useApi<ServerPortfolio[]>("/api/admin/portfolios");
  const { portfolio } = useSession();
  const toast = useToast();
  const fail = (err: unknown) => toast({ text: (err as Error).message, kind: "error" });
  const [pwFor, setPwFor] = useState<Login | null>(null);
  const [pw, setPw] = useState("");
  const blank = { email: "", name: "", password: "", role: "member", portfolio: "" };
  const [form, setForm] = useState(blank);
  const open = list.data?.filter((p) => !p.archived) ?? [];
  const target = form.portfolio || open.find((p) => p.slug === portfolio.slug)?.slug || open[0]?.slug || "";

  const patchLogin = async (u: Login, json: Record<string, unknown>) => {
    try {
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", json });
      void logins.reload();
      if (json.password) toast({ text: `Password set for ${u.email}`, kind: "ok" });
    } catch (err) {
      fail(err);
    }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const p = open.find((x) => x.slug === target);
    if (!p) return;
    try {
      await api("/api/admin/users", {
        method: "POST",
        json: {
          email: form.email,
          name: form.name,
          password: form.password || undefined,
          role: form.role,
          portfolio_id: p.id,
        },
      });
      setForm(blank);
      void logins.reload();
      void list.reload();
      toast({ text: `Login added to ${p.name}`, kind: "ok" });
    } catch (err) {
      fail(err);
    }
  };

  return (
    <>
      <section className="card table-card">
        <h2>Logins</h2>
        <p className="muted card-pad-x">
          A login can have access to several portfolios. Its password and whether it's enabled affect all of them, so
          they're set here, not by the admins of each.
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Portfolios</th>
              <th>Sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {logins.data?.map((u) => (
              <tr key={u.id} className={u.disabled ? "excluded" : ""}>
                <td>
                  {u.email}
                  {u.name && <div className="muted small">{u.name}</div>}
                  {u.instance_admin && <div className="muted small">server administrator</div>}
                </td>
                <td>{u.portfolios.map((p) => `${p.name} (${p.role})`).join(", ") || "none yet"}</td>
                <td>
                  {u.disabled
                    ? "disabled"
                    : [u.has_password ? "password" : null, u.has_sso ? "SSO" : null].filter(Boolean).join(", ") || "—"}
                </td>
                <td className="row-actions">
                  <button className="link" onClick={() => (setPw(""), setPwFor(u))}>
                    Set password
                  </button>
                  {!u.instance_admin && (
                    <button className="link" onClick={() => void patchLogin(u, { disabled: !u.disabled })}>
                      {u.disabled ? "Enable" : "Disable"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form className="card" onSubmit={create}>
        <h2>Add a login with a password</h2>
        <p className="muted">
          For someone who won't use an invite link. Everyone else joins with a link from Settings → Who has access.
        </p>
        <div className="row-2">
          <label>
            Email
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Gets access to
            <select value={target} onChange={(e) => setForm({ ...form, portfolio: e.target.value })}>
              {open.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Role there
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {(["member", "viewer", "admin"] as const).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Initial password (optional if they'll use SSO)
          <input
            type="password"
            minLength={10}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            autoComplete="new-password"
          />
        </label>
        <button className="btn primary" disabled={!target}>
          Add login
        </button>
      </form>

      {pwFor && (
        <Modal title={`New password for ${pwFor.email}`} onClose={() => setPwFor(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void patchLogin(pwFor, { password: pw }).then(() => setPwFor(null));
            }}
          >
            <label>
              Password (at least 10 characters)
              <input
                type="password"
                required
                minLength={10}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete="new-password"
                autoFocus
              />
            </label>
            <button className="btn primary">Set password</button>
          </form>
        </Modal>
      )}
    </>
  );
}
