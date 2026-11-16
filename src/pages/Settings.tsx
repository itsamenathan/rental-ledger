import { useState, type FormEvent } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router";
import { api, type Property } from "../api.ts";
import { useApi, useSession, useToast } from "../hooks.ts";
import { Modal } from "../lib.tsx";
import CategorySettings from "./CategorySettings.tsx";
import { PropertyCalendars } from "../components/CalendarFeeds.tsx";

export default function Settings() {
  const { user } = useSession();
  return (
    <div className="page">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      <nav className="tabs">
        <NavLink to="/settings/account">Account</NavLink>
        <NavLink to="/settings/api-keys">API keys &amp; agents</NavLink>
        <NavLink to="/settings/properties">Properties</NavLink>
        <NavLink to="/settings/categories">Categories</NavLink>
        {user.role === "admin" && <NavLink to="/settings/users">Users</NavLink>}
        {user.role === "admin" && <NavLink to="/settings/backup">Backup</NavLink>}
        <NavLink to="/settings/audit">Audit log</NavLink>
      </nav>
      <Routes>
        <Route path="account" element={<Account />} />
        <Route path="api-keys" element={<ApiKeys />} />
        <Route
          path="properties"
          element={
            <>
              <Properties />
              <PropertyCalendars />
            </>
          }
        />
        <Route path="categories" element={<CategorySettings />} />
        <Route path="users" element={<Users />} />
        <Route path="backup" element={<Backup />} />
        <Route path="audit" element={<AuditLog />} />
        <Route path="activity" element={<Navigate to="../audit" replace />} />
        <Route path="*" element={<Navigate to="account" replace />} />
      </Routes>
    </div>
  );
}

function Account() {
  const { user, logout } = useSession();
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
          <dt>Role</dt>
          <dd>{user.role}</dd>
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
  const { data, reload } = useApi<Key[]>("api-keys");
  const [name, setName] = useState("");
  const [scope, setScope] = useState("write");
  const [created, setCreated] = useState<string | null>(null);
  const toast = useToast();
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
    if (!confirm("Revoke this key? Anything using it will stop working.")) return;
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
          agents that add or fix entries. Every change is logged with the key's name.
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

function Properties() {
  const { overview, reloadOverview, canWrite } = useSession();
  const [editing, setEditing] = useState<Partial<Property> | null>(null);
  const toast = useToast();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const p = editing!;
    const json = {
      name: p.name,
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
      await reloadOverview();
      setEditing(null);
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
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
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Address</th>
            <th>In service</th>
            <th className="num">Building basis</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {overview.properties.map((p) => (
            <tr key={p.id} className={p.archived ? "excluded" : ""}>
              <td>{p.name}</td>
              <td>{p.address}</td>
              <td>{p.placed_in_service ?? "—"}</td>
              <td className="num">
                {p.building_basis?.toLocaleString("en-US", { style: "currency", currency: "USD" }) ?? "—"}
              </td>
              <td>
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
      {editing && (
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
              <input
                value={editing.address ?? ""}
                onChange={(e) => setEditing({ ...editing, address: e.target.value })}
              />
            </label>
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
              Basis and in-service date are used to estimate depreciation on the tax report. Your preparer's
              depreciation schedule is authoritative.
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
      )}
    </section>
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
      <a className="btn primary" href="/api/backup" download>
        Download backup
      </a>
      <p className="muted small">
        The file contains password and API key hashes, so keep it somewhere private. From a terminal:{" "}
        <code>node server/cli.ts backup --out backup.zip</code>.
      </p>
      <RestoreBackup />
      <h3>Spreadsheet copy</h3>
      <p className="muted small">Every transaction as a CSV, for Excel, Google Sheets or your tax preparer.</p>
      <a className="btn" href="/api/export/transactions.csv">
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

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: string;
  disabled: number;
  has_password: number;
  has_sso: number;
}

function Users() {
  const { user } = useSession();
  const { data, reload } = useApi<UserRow[]>(user.role === "admin" ? "users" : null);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "member" });
  const toast = useToast();
  if (user.role !== "admin") return <Navigate to="/settings" />;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("users", { method: "POST", json: { ...form, password: form.password || undefined } });
      setForm({ email: "", name: "", password: "", role: "member" });
      void reload();
      toast({ text: "User added", kind: "ok" });
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  const patch = async (id: number, json: Record<string, unknown>) => {
    try {
      await api(`users/${id}`, { method: "PATCH", json });
      void reload();
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  return (
    <>
      <section className="card table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((u) => (
              <tr key={u.id} className={u.disabled ? "excluded" : ""}>
                <td>{u.email}</td>
                <td>{u.name}</td>
                <td>
                  <select
                    value={u.role}
                    onChange={(e) => void patch(u.id, { role: e.target.value })}
                    disabled={u.id === user.id}
                    aria-label="Role"
                  >
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                    <option value="viewer">viewer (read-only)</option>
                  </select>
                </td>
                <td>
                  {[u.has_password ? "password" : null, u.has_sso ? "SSO" : null].filter(Boolean).join(", ") || "—"}
                </td>
                <td>
                  {u.id !== user.id && (
                    <button className="link" onClick={() => void patch(u.id, { disabled: !u.disabled })}>
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
        <h2>Add user</h2>
        <div className="row-3">
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
            Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="member">member</option>
              <option value="viewer">viewer (read-only, e.g. your accountant)</option>
              <option value="admin">admin</option>
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
        <button className="btn primary">Add user</button>
      </form>
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
};
const NOUN: Record<string, string> = {
  transaction: "transaction",
  recurring_dismissal: "recurring-bill mark",
  preparer_package: "preparer package",
  api_key: "API key",
  tax_year: "tax-year inputs",
  calendar_feed: "calendar",
  audit: "change",
};

/** One readable line for an audit entry. */
function describe(r: AuditRow) {
  const verb = VERB[r.action] ?? r.action;
  if (r.action === "login" || r.action === "logout" || r.action === "change_password") return verb;
  const noun = (NOUN[r.entity] ?? r.entity.replace(/_/g, " ")) + (r.action === "bulk_create" ? "s" : "");
  const ref = r.entity_id && r.entity !== "subcategory" && r.entity !== "audit" ? ` #${r.entity_id}` : "";
  return `${verb} ${noun}${r.action === "undo" ? ` #${r.entity_id}` : ref}`;
}

function details(r: AuditRow) {
  const c = (r.changes ?? {}) as Record<string, unknown>;
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
function AuditLog() {
  const { canWrite } = useSession();
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const [logins, setLogins] = useState(false);
  const { data, reload } = useApi<AuditRow[]>(`audit?limit=100&offset=${offset}${logins ? "" : "&hide_logins=true"}`);
  const undo = async (r: AuditRow) => {
    if (!confirm(`Undo this change?\n\n${r.undo}`)) return;
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
          Every change, who made it and from where (web, API or AI agent). Use Undo to reverse one.
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
