import { useState, type FormEvent, type ReactNode } from "react";
import { apiUrl, BASENAME } from "../portfolio.ts";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { api, type Property, type UserSettings } from "../api.ts";
import { useApi, useProperty, useSession, useToast, useConfirm } from "../hooks.ts";
import { Modal } from "../lib.tsx";
import CategorySettings from "./CategorySettings.tsx";
import { PropertyCalendars } from "../components/CalendarFeeds.tsx";
import { propertySettingsPath } from "../scope.ts";
import { slugTyping } from "../../server/slugs.ts";
import { fmtDate } from "../format.ts";
import {
  DownloadPortfolio,
  People,
  PortfolioGeneral,
  ServerLogins,
  ServerNote,
  ServerPortfolios,
} from "./Portfolios.tsx";

type NavItem = { to: string; label: string; show?: boolean };

/**
 * Settings, grouped by whom a setting affects: you (your login, everywhere), this portfolio, and the whole
 * server (its administrator only). Each group says so in its heading.
 */
export default function Settings() {
  const { user, portfolio } = useSession();
  const admin = user.role === "admin" && !portfolio.viewing;
  const groups: { title: string; note?: string; items: NavItem[]; server?: boolean }[] = [
    {
      title: "Your account",
      note: user.email,
      items: [
        { to: "account", label: "Account" },
        { to: "preferences", label: "Preferences" },
      ],
    },
    {
      title: "Portfolio",
      note: `${portfolio.name}${portfolio.viewing ? " · read-only" : ""}`,
      items: [
        { to: "portfolio", label: "General" },
        { to: "properties", label: "Properties" },
        { to: "categories", label: "Categories" },
        { to: "people", label: "Who has access", show: admin },
        { to: "api-keys", label: "API keys & agents", show: !portfolio.viewing },
        { to: "audit", label: "Change history" },
        { to: "download", label: "Download everything" },
      ],
    },
    ...(user.instance_admin
      ? [
          {
            title: "Server",
            note: "only you",
            server: true,
            items: [
              { to: "server/portfolios", label: "All portfolios" },
              { to: "server/logins", label: "Logins" },
              { to: "server/backup", label: "Backup & restore" },
              { to: "server/activity", label: "Server activity" },
            ],
          },
        ]
      : []),
  ];
  const server = (el: ReactNode) =>
    user.instance_admin ? (
      <>
        {<ServerNote />}
        {el}
      </>
    ) : (
      <Navigate to="/settings" replace />
    );
  return (
    <div className="page settings-page">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings">
          {groups.map((g) => (
            <div key={g.title} className={`settings-group ${g.server ? "server" : ""}`}>
              <div className="settings-group-head">
                <span className="settings-group-title">{g.title}</span>
                {g.note && <span className="settings-group-note">{g.note}</span>}
              </div>
              {g.items
                .filter((i) => i.show !== false)
                .map((i) => (
                  <NavLink key={i.to} to={`/settings/${i.to}`}>
                    {i.label}
                  </NavLink>
                ))}
            </div>
          ))}
        </nav>
        <div className="settings-body">
          <Routes>
            <Route path="account" element={<Account />} />
            <Route path="preferences" element={<Preferences />} />
            <Route path="portfolio" element={<PortfolioGeneral />} />
            <Route path="properties" element={<Properties />} />
            <Route path="categories" element={<CategorySettings />} />
            <Route path="people" element={<People />} />
            <Route path="api-keys" element={<ApiKeys />} />
            <Route path="audit" element={<AuditLog />} />
            <Route path="download" element={<DownloadPortfolio />} />
            <Route path="server/portfolios" element={server(<ServerPortfolios />)} />
            <Route path="server/logins" element={server(<ServerLogins />)} />
            <Route path="server/backup" element={server(<Backup />)} />
            <Route path="server/activity" element={server(<AuditLog server />)} />
            {/* earlier addresses */}
            <Route path="users" element={<Navigate to="../people" replace />} />
            <Route path="server" element={<Navigate to="../server/portfolios" replace />} />
            <Route path="backup" element={<Navigate to="../server/backup" replace />} />
            <Route path="activity" element={<Navigate to="../audit" replace />} />
            <Route path="*" element={<Navigate to="account" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function Account() {
  const { user, logout, portfolio } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const toast = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("auth/password", { method: "POST", json: { current, next } });
      setCurrent("");
      setNext("");
      toast({ text: "Password changed", kind: "ok" });
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  return (
    <div className="grid-2">
      <section className="card">
        <h2>Profile</h2>
        <dl className="kv">
          <dt>Email</dt>
          <dd>{user.email}</dd>
          <dt>Name</dt>
          <dd>{user.name || "—"}</dd>
          <dt>{`Role in ${portfolio.name}`}</dt>
          <dd>{portfolio.viewing ? "looking in (read-only)" : user.role}</dd>
        </dl>
        <button className="btn" onClick={() => void logout()}>
          Sign out
        </button>
      </section>
      <form className="card" onSubmit={submit}>
        <h2>Change password</h2>
        <label>
          Current password
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <label>
          New password (10+ characters)
          <input
            type="password"
            required
            minLength={10}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <button className="btn primary">Update password</button>
      </form>
    </div>
  );
}

/** One preference: what it is on the left, the choices on the right. */
function Choice<T extends string | number>({
  title,
  help,
  value,
  options,
  disabled,
  onChange,
}: {
  title: string;
  help: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <div className="pref">
      <div className="pref-text">
        <strong>{title}</strong>
        <span className="muted small">{help}</span>
      </div>
      <div className="segmented" role="radiogroup" aria-label={title}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={value === o.value ? "on" : ""}
            disabled={disabled}
            onClick={() => value !== o.value && onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Your own preferences: they follow you to any device and don't change anyone else's view. */
function Preferences() {
  const { settings, updateSettings } = useSession();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const save = async (patch: Partial<UserSettings>) => {
    setSaving(true);
    try {
      await updateSettings(patch);
      toast({ text: "Preference saved", kind: "ok" });
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <p className="muted">These apply to your account only, on any device you sign in from.</p>
      <div className="grid-2">
        <section className="card">
          <h2>Calendar</h2>
          <Choice
            title="Week starts on"
            help="The first column of the calendar grid."
            value={settings.week_start}
            options={[
              { value: 0, label: "Sunday" },
              { value: 1, label: "Monday" },
              { value: 6, label: "Saturday" },
            ]}
            disabled={saving}
            onChange={(week_start) => void save({ week_start })}
          />
        </section>
      </div>
    </>
  );
}

interface Key {
  id: number;
  name: string;
  prefix: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function ApiKeys() {
  const { portfolio } = useSession();
  const { data, reload } = useApi<Key[]>("api-keys");
  const [name, setName] = useState("");
  const [scope, setScope] = useState("write");
  const [created, setCreated] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const origin = location.origin;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ key: string }>("api-keys", { method: "POST", json: { name, scope } });
      setCreated(r.key);
      setName("");
      void reload();
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  const revoke = async (id: number) => {
    if (
      !(await confirm({
        title: "Revoke this key?",
        message: "Anything using it will stop working.",
        confirm: "Revoke key",
        danger: true,
      }))
    )
      return;
    await api(`api-keys/${id}`, { method: "DELETE" });
    void reload();
  };
  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        rental: { type: "http", url: `${origin}/mcp`, headers: { Authorization: `Bearer ${created ?? "rk_..."}` } },
      },
    },
    null,
    2,
  );

  return (
    <>
      <section className="card">
        <h2>Create an API key</h2>
        <p className="muted">
          Keys act as you. Use a <strong>read</strong> key for agents that only analyze, and <strong>write</strong> for
          agents that add or fix entries. Every change is logged with the key's name. A key works only in{" "}
          <strong>{portfolio.name}</strong>.
        </p>
        <form className="inline-form" onSubmit={create}>
          <input
            required
            placeholder="Name, e.g. Claude bookkeeping"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope">
            <option value="write">Read &amp; write</option>
            <option value="read">Read only</option>
          </select>
          <button className="btn primary">Create key</button>
        </form>
        {created && (
          <div className="alert ok">
            <p>Copy this key now. It won't be shown again.</p>
            <code className="secret">{created}</code>
            <button
              className="btn small"
              onClick={() =>
                void navigator.clipboard.writeText(created).then(() => toast({ text: "Copied", kind: "ok" }))
              }
            >
              Copy
            </button>
          </div>
        )}
      </section>
      <section className="card table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Scope</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((k) => (
              <tr key={k.id} className={k.revoked_at ? "excluded" : ""}>
                <td>{k.name}</td>
                <td>
                  <code>rk_{k.prefix}_…</code>
                </td>
                <td>{k.scope}</td>
                <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}</td>
                <td>
                  {k.revoked_at ? (
                    "revoked"
                  ) : (
                    <button className="link danger" onClick={() => void revoke(k.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>Connect an AI agent</h2>
        <p>
          <strong>MCP</strong> (Claude Code, Claude Desktop, and other MCP clients): add this server.
        </p>
        <pre className="code">{mcpConfig}</pre>
        <p>
          For Claude Code:{" "}
          <code>claude mcp add --transport http rental {origin}/mcp --header "Authorization: Bearer rk_..."</code>
        </p>
        <p>
          <strong>REST</strong>: see the API guide at{" "}
          <a href="/llms.txt" target="_blank" rel="noreferrer">
            /llms.txt
          </a>
          . Agents can read it to learn the data model and endpoints.
        </p>
      </section>
    </>
  );
}

/** App settings → Properties: the list, and adding one. Each property's own settings are at /<property slug>/settings. */
function Properties() {
  const { overview, canWrite } = useSession();
  const [editing, setEditing] = useState<Partial<Property> | null>(null);
  return (
    <section className="card">
      <div className="section-head">
        <h2>Properties</h2>
        {canWrite && (
          <button className="btn" onClick={() => setEditing({ recovery_years: 27.5 })}>
            + Add property
          </button>
        )}
      </div>
      {!overview.properties.length && <p className="empty">Add your first rental property to get started.</p>}
      <p className="muted small">
        Each property keeps its own books: entries, occupancy, booking calendars, tax-year inputs and manager paperwork.
        Users, categories and receipt rules are shared.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th className="hide-sm">Address</th>
            <th className="hide-sm">In service</th>
            <th className="num hide-sm">Building basis</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {overview.properties.map((p) => (
            <tr key={p.id} className={p.archived ? "excluded" : ""}>
              <td>
                <Link to={propertySettingsPath(p.slug)}>{p.name}</Link>
                {p.archived && <small className="muted"> archived</small>}
              </td>
              <td className="hide-sm">{p.address}</td>
              <td className="hide-sm nowrap">{p.placed_in_service ? fmtDate(p.placed_in_service) : "—"}</td>
              <td className="num hide-sm">
                {p.building_basis?.toLocaleString("en-US", { style: "currency", currency: "USD" }) ?? "—"}
              </td>
              <td className="num">
                {canWrite && (
                  <button className="link" onClick={() => setEditing(p)}>
                    Edit
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <PropertyModal editing={editing} setEditing={setEditing} />}
    </section>
  );
}

/** One property's settings: its details and booking calendars. */
export function PropertySettings() {
  const { canWrite } = useSession();
  const { property } = useProperty();
  const [editing, setEditing] = useState<Partial<Property> | null>(null);
  if (!property) return null;
  const p = property;
  return (
    <div className="page">
      <header className="page-head">
        <h1>{p.name}</h1>
        <Link className="link small" to="/settings/properties">
          All properties
        </Link>
      </header>
      <section className="card">
        <div className="section-head">
          <h2>Details</h2>
          {canWrite && (
            <button className="btn small" onClick={() => setEditing(p)}>
              Edit
            </button>
          )}
        </div>
        <dl className="details">
          <dt>Address</dt>
          <dd>{p.address || "—"}</dd>
          <dt>Placed in service</dt>
          <dd>{p.placed_in_service ? fmtDate(p.placed_in_service) : "—"}</dd>
          <dt>Building basis</dt>
          <dd>{p.building_basis?.toLocaleString("en-US", { style: "currency", currency: "USD" }) ?? "—"}</dd>
          <dt>Recovery period</dt>
          <dd>{p.recovery_years} years</dd>
          {p.notes && (
            <>
              <dt>Notes</dt>
              <dd className="pre-wrap">{p.notes}</dd>
            </>
          )}
          {p.archived && (
            <>
              <dt>Status</dt>
              <dd>Archived</dd>
            </>
          )}
        </dl>
      </section>
      <PropertyCalendars propertyId={p.id} />
      {editing && <PropertyModal editing={editing} setEditing={setEditing} />}
    </div>
  );
}

function PropertyModal({
  editing,
  setEditing,
}: {
  editing: Partial<Property>;
  setEditing: (p: Partial<Property> | null) => void;
}) {
  const { reloadOverview, overview } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const loc = useLocation();
  const before = overview.properties.find((x) => x.id === editing.id);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const p = editing;
    const slugChanged = !!before && !!p.slug && p.slug !== before.slug;
    const json = {
      name: p.name,
      ...(slugChanged ? { slug: p.slug } : {}),
      address: p.address ?? "",
      placed_in_service: p.placed_in_service || null,
      building_basis:
        p.building_basis === undefined || p.building_basis === null || String(p.building_basis) === ""
          ? null
          : Number(p.building_basis),
      recovery_years: Number(p.recovery_years ?? 27.5),
      notes: p.notes ?? "",
      archived: !!p.archived,
    };
    try {
      if (p.id) await api(`properties/${p.id}`, { method: "PATCH", json });
      else await api("properties", { method: "POST", json });
      // On one of this property's pages: follow it to its new address.
      const [, seg, ...rest] = loc.pathname.split("/");
      const follow = slugChanged && seg === before.slug ? `/${[p.slug, ...rest].join("/")}${loc.search}` : null;
      await reloadOverview(follow ? () => void navigate(follow, { replace: true }) : undefined);
      setEditing(null);
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  return (
    <Modal title={editing.id ? "Edit property" : "Add property"} onClose={() => setEditing(null)}>
      <form onSubmit={save}>
        <label>
          Name
          <input
            required
            value={editing.name ?? ""}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
        </label>
        <label>
          Address
          <input value={editing.address ?? ""} onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
        </label>
        {before && (
          <label>
            Web address
            <span className="slug-input">
              <span className="muted">
                {location.host}
                {BASENAME}/
              </span>
              <input
                required
                value={editing.slug ?? ""}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                title="Lowercase letters, numbers and dashes"
                maxLength={40}
                onChange={(e) => setEditing({ ...editing, slug: slugTyping(e.target.value) })}
              />
            </span>
            <span className="muted small">
              Renaming keeps it. Links to the old address stop working when it changes.
            </span>
          </label>
        )}
        <div className="row-3">
          <label>
            Placed in service
            <input
              type="date"
              value={editing.placed_in_service ?? ""}
              onChange={(e) => setEditing({ ...editing, placed_in_service: e.target.value })}
            />
          </label>
          <label>
            Building basis ($, excl. land)
            <input
              inputMode="decimal"
              value={editing.building_basis ?? ""}
              onChange={(e) => setEditing({ ...editing, building_basis: e.target.value as unknown as number })}
            />
          </label>
          <label>
            Recovery period (years)
            <select
              value={editing.recovery_years ?? 27.5}
              onChange={(e) => setEditing({ ...editing, recovery_years: Number(e.target.value) })}
            >
              <option value={27.5}>27.5 (residential rental)</option>
              <option value={39}>39 (nonresidential, e.g. avg stay ≤ 7 days)</option>
            </select>
          </label>
        </div>
        <p className="muted small">
          Basis and in-service date are used to estimate depreciation on the tax report. Your preparer's depreciation
          schedule is authoritative.
        </p>
        <label>
          Notes
          <textarea
            rows={3}
            value={editing.notes ?? ""}
            onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
          />
        </label>
        {editing.id && (
          <label className="check">
            <input
              type="checkbox"
              checked={!!editing.archived}
              onChange={(e) => setEditing({ ...editing, archived: e.target.checked })}
            />{" "}
            Archived
          </label>
        )}
        <div className="form-actions">
          <span className="spacer" />
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function Backup() {
  return (
    <section className="card">
      <h2>Backup</h2>
      <p>
        Downloads everything in one <code>.zip</code>: the whole database (transactions, categories, occupancy, users,
        settings, change history) and all receipt files. It's safe to run while the app is in use.
      </p>
      <a className="btn primary" href={apiUrl("/api/backup")} download>
        Download backup
      </a>
      <p className="muted small">
        The file contains password and API key hashes, so keep it somewhere private. From a terminal:{" "}
        <code>node server/cli.ts backup --out backup.zip</code>.
      </p>
      <RestoreBackup />
      <h3>Spreadsheet copy</h3>
      <p className="muted small">Every transaction as a CSV, for Excel, Google Sheets or your tax preparer.</p>
      <a className="btn" href={apiUrl("/api/export/transactions.csv?property=all")}>
        Download all transactions (CSV)
      </a>
    </section>
  );
}

interface RestoreResult {
  transactions: number;
  users: number;
  receipts: number;
  previous_data_saved_as: string;
}

function RestoreBackup() {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<RestoreResult | null>(null);
  const restore = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await api<RestoreResult>("backup/restore", {
        method: "POST",
        headers: { "content-type": "application/zip", "x-filename": encodeURIComponent(file.name) },
        body: file,
      });
      setDone(r);
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <div className="danger-box">
        <h3>Restored</h3>
        <p>
          Loaded {done.transactions} transactions, {done.users} users and {done.receipts} receipts. Your previous data
          was saved on the server as <code>{done.previous_data_saved_as}</code>.
        </p>
        <button className="btn primary" onClick={() => window.location.reload()}>
          Reload the app
        </button>
        <p className="muted small">You may need to sign in again with an account from the backup.</p>
      </div>
    );
  return (
    <>
      <h3>Restore from backup</h3>
      <p className="muted small">
        Replaces <strong>all</strong> current data (transactions, categories, users, settings, receipts) with the
        contents of a backup <code>.zip</code>. The current data is saved on the server first, in <code>backups/</code>{" "}
        in the data folder, so a restore can itself be undone by restoring that file.
      </p>
      <div className="danger-box">
        <label>
          Backup file
          <input
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setSure(false);
            }}
          />
        </label>
        {file && (
          <label className="check">
            <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
            Replace everything with {file.name}
          </label>
        )}
        <div className="form-actions">
          <span className="spacer" />
          <button className="btn danger-outline" disabled={!file || !sure || busy} onClick={() => void restore()}>
            {busy ? "Restoring…" : "Restore"}
          </button>
        </div>
      </div>
    </>
  );
}

interface AuditRow {
  id: number;
  at: string;
  via: string;
  action: string;
  entity: string;
  entity_id: number | null;
  changes: unknown;
  user_email: string | null;
  api_key_name: string | null;
  /** what undo would do, or null if this kind of change can't be undone */
  undo: string | null;
  undone: boolean;
}

const show = (v: unknown) =>
  v == null || v === "" ? "(blank)" : typeof v === "object" ? JSON.stringify(v) : String(v as string);

const VERB: Record<string, string> = {
  create: "Added",
  update: "Edited",
  delete: "Deleted",
  restore: "Restored",
  bulk_create: "Added several",
  rename: "Renamed",
  revoke: "Revoked",
  export: "Downloaded",
  undo: "Undid",
  login: "Signed in",
  logout: "Signed out",
  change_password: "Changed password",
  sync: "Synced",
  import: "Imported",
};
const NOUN: Record<string, string> = {
  transaction: "transaction",
  recurring_dismissal: "recurring-bill mark",
  preparer_package: "preparer package",
  api_key: "API key",
  tax_year: "tax-year inputs",
  calendar_feed: "calendar",
  calendar_history: "reservation history",
  audit: "change",
};

/** Entries about the portfolio, access and logins, in plain words (never "membership"). */
function describeAccess(r: AuditRow): string | null {
  const c = (r.changes ?? {}) as Record<string, unknown>;
  const who = typeof c.email === "string" ? c.email : "someone";
  switch (`${r.entity}:${r.action}`) {
    case "portfolio:view":
      return "Server administrator looked in (read-only)";
    case "portfolio:create":
      return "Created this portfolio";
    case "portfolio:update":
      return "archived" in c
        ? Array.isArray(c.archived) && c.archived[1]
          ? "Archived this portfolio"
          : "Unarchived this portfolio"
        : "name" in c
          ? "Renamed this portfolio"
          : "slug" in c
            ? "Changed the portfolio's web address"
            : "Changed this portfolio";
    case "membership:create":
      return `Gave ${who} access${c.role ? ` (${show(c.role)})` : ""}`;
    case "membership:update":
      return `Changed ${who}'s role`;
    case "membership:delete":
      return c.left ? `${who} left` : `Removed ${who}'s access`;
    case "invite:create":
      return `Made an invite link${c.role ? ` (${show(c.role)})` : ""}`;
    case "invite:revoke":
      return "Cancelled an invite link";
    case "download:export":
      return "Downloaded everything";
    case "user:create":
      return `Added the login ${who}`;
    case "user:update":
      return `Changed the login ${who}`;
    case "user_settings:update":
      return "Changed preferences";
    default:
      return null;
  }
}

/** One readable line for an audit entry. */
function describe(r: AuditRow) {
  const access = describeAccess(r);
  if (access) return access;
  const verb = VERB[r.action] ?? r.action;
  if (r.action === "login" || r.action === "logout" || r.action === "change_password") return verb;
  const noun = (NOUN[r.entity] ?? r.entity.replace(/_/g, " ")) + (r.action === "bulk_create" ? "s" : "");
  const ref = r.entity_id && r.entity !== "subcategory" && r.entity !== "audit" ? ` #${r.entity_id}` : "";
  return `${verb} ${noun}${r.action === "undo" ? ` #${r.entity_id}` : ref}`;
}

function details(r: AuditRow) {
  const c = (r.changes ?? {}) as Record<string, unknown>;
  if (r.entity === "portfolio" && r.action === "view") return "";
  if (r.entity === "membership" && Array.isArray(c.role)) return `${show(c.role[0])} → ${show(c.role[1])}`;
  if (r.entity === "invite" || r.entity === "membership") return c.note ? show(c.note) : "";
  if (r.entity === "download") return `${show(c.transactions)} transactions, ${show(c.receipts)} receipts`;
  // field diffs look like { field: [before, after] }
  if (r.action === "update" && Object.values(c).every((v) => Array.isArray(v) && v.length === 2))
    return Object.entries(c as Record<string, [unknown, unknown]>)
      .filter(([k]) => !["category", "kind", "schedule_e_line", "property"].includes(k) || !("category_id" in c))
      .map(([k, [a, b]]) => `${k.replace(/_/g, " ")}: ${show(a)} → ${show(b)}`)
      .join(" · ");
  if (r.entity === "transaction" && "amount" in c)
    return [c.date, c.category, c.subcategory || c.vendor, show(c.amount)].filter(Boolean).join(" · ");
  if (r.entity === "subcategory" && r.action === "rename")
    return `${show(c.category)}: ${show(c.from)} → ${show(c.to)} (${(c.transactions as unknown[])?.length ?? 0} transactions)`;
  if (r.entity === "subcategory")
    return `${show(c.category ?? "")} ${show(c.name)}${c.moved_to ? ` → ${show(c.moved_to)}` : ""}`.trim();
  if (r.entity === "occupancy")
    return `${show(c.month ?? "")} · ${show(c.nights_booked ?? "")} nights booked`.replace(/^ · /, "");
  if (r.entity === "calendar_feed" && r.action === "sync")
    return `${show(c.name)}: ${show(c.added)} added, ${show(c.updated)} changed, ${show(c.removed)} cancelled`;
  if (r.entity === "calendar_history" && r.action === "import")
    return `Reservation history${c.listing ? ` (${show(c.listing)})` : ""}: ${show(c.added)} added, ${show(c.updated)} changed`;
  if (r.entity === "calendar_history" && r.action === "delete") return `${show(c.removed)} imported stays removed`;
  if (r.action === "undo") return `${VERB[String(c.action)] ?? show(c.action)} ${show(c.entity)} #${show(c.entity_id)}`;
  if (Array.isArray(c.ids)) return `${c.ids.length} transactions`;
  if (Array.isArray(c.transactions)) return `${c.transactions.length} transactions`;
  const text = Object.entries(c)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${show(v)}`)
    .join(" · ");
  return text.length > 160 ? text.slice(0, 157) + "…" : text;
}

/** Settings → Audit log: every change, who made it, and a one-click undo where possible. */
/** This portfolio's audit log, or (`server`) the server's own activity: backups, logins, portfolios. */
function AuditLog({ server = false }: { server?: boolean }) {
  const { canWrite: writable } = useSession();
  const canWrite = writable && !server;
  const toast = useToast();
  const confirm = useConfirm();
  const [offset, setOffset] = useState(0);
  const [logins, setLogins] = useState(false);
  const { data, reload } = useApi<AuditRow[]>(
    `${server ? "/api/admin/audit" : "audit"}?limit=100&offset=${offset}${logins ? "" : "&hide_logins=true"}`,
  );
  const undo = async (r: AuditRow) => {
    if (!(await confirm({ title: "Undo this change?", message: r.undo ?? "", confirm: "Undo" }))) return;
    try {
      await api(`audit/${r.id}/undo`, { method: "POST" });
      toast({ text: "Undone", kind: "ok" });
      void reload();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  return (
    <section className="card table-card">
      <div className="section-head card-pad">
        <p className="muted small">
          {server
            ? "Backups and restores, logins being added or changed, and portfolios being created, archived or looked into. Each portfolio keeps its own change history."
            : "Every change, who made it and from where (web, API or AI agent). Use Undo to reverse one."}
        </p>
        <label className="check small">
          <input type="checkbox" checked={logins} onChange={(e) => setLogins(e.target.checked)} /> Show sign-ins
        </label>
      </div>
      <table className="data-table audit-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Details</th>
            {canWrite && <th />}
          </tr>
        </thead>
        <tbody>
          {data?.map((r) => (
            <tr key={r.id} className={r.undone ? "excluded" : ""}>
              <td className="nowrap">{new Date(r.at).toLocaleString()}</td>
              <td>
                {r.user_email ?? "system"}
                <small className="muted">
                  {" "}
                  via {r.via}
                  {r.api_key_name ? ` (${r.api_key_name})` : ""}
                </small>
              </td>
              <td className="nowrap">{describe(r)}</td>
              <td className="desc audit-details">{details(r)}</td>
              {canWrite && (
                <td className="nowrap">
                  {r.undone ? (
                    <span className="muted small">undone</span>
                  ) : r.undo ? (
                    <button className="btn small" title={r.undo} onClick={() => void undo(r)}>
                      Undo
                    </button>
                  ) : null}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pager">
        <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>
          ← Newer
        </button>
        <button className="btn" disabled={(data?.length ?? 0) < 100} onClick={() => setOffset(offset + 100)}>
          Older →
        </button>
      </div>
    </section>
  );
}
