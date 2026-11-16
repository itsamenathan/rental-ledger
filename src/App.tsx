import { useEffect, useState, type FormEvent } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { api, type User } from "./api.ts";
import { useApi, useOutbox, useSession } from "./hooks.ts";
import { Modal, SessionProvider, ToastProvider } from "./lib.tsx";
import { OutboxProvider, SyncBanner } from "./components/Outbox.tsx";
import Overview from "./pages/Overview.tsx";
import MonthPage from "./pages/Month.tsx";
import Categories from "./pages/Categories.tsx";
import RecurringPage from "./pages/Recurring.tsx";
import Transactions from "./pages/Transactions.tsx";
import AddEntry from "./pages/AddEntry.tsx";
import Todo, { type TodoSummary } from "./pages/Todo.tsx";
import Occupancy from "./pages/Occupancy.tsx";
import Reports from "./pages/Reports.tsx";
import ImportCsv from "./pages/ImportCsv.tsx";
import ManagerStatement from "./pages/ManagerStatement.tsx";
import Files from "./pages/Files.tsx";
import Settings from "./pages/Settings.tsx";

interface Me {
  user: User | null;
  can_write: boolean;
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = () =>
    api<Me>("auth/me")
      .then(setMe)
      .catch(() => setMe({ user: null, can_write: false }));
  useEffect(() => {
    void refresh();
    const onExpired = () => setMe({ user: null, can_write: false });
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, []);

  if (!me) return <div className="boot">Loading…</div>;
  return (
    <BrowserRouter>
      <ToastProvider>
        {me.user ? (
          <SessionProvider
            user={me.user}
            canWrite={me.can_write}
            onLogout={() => setMe({ user: null, can_write: false })}
          >
            <OutboxProvider>
              <Shell />
            </OutboxProvider>
          </SessionProvider>
        ) : (
          <Routes>
            <Route path="*" element={<Login onDone={refresh} />} />
          </Routes>
        )}
      </ToastProvider>
    </BrowserRouter>
  );
}

const NAV = [
  { to: "/", label: "Overview", icon: "M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z" },
  { to: "/todo", label: "To do", icon: "M9 12l2 2 4-4M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" },
  { to: "/statement", label: "Manager", icon: "M4 4h16v16H4zM8 9h8M8 13h8M8 17h5" },
  {
    to: "/files",
    label: "Files",
    icon: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
  },
  { to: "/categories", label: "Categories", icon: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18" },
  { to: "/transactions", label: "Transactions", icon: "M4 6h16M4 12h16M4 18h10" },
  { to: "/add", label: "Add", icon: "M12 5v14M5 12h14", primary: true },
  {
    to: "/recurring",
    label: "Recurring",
    icon: "M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
  },
  { to: "/reports", label: "Taxes", icon: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" },
  { to: "/occupancy", label: "Occupancy", icon: "M4 5h16v15H4zM4 10h16M9 3v4M15 3v4" },
  {
    to: "/settings",
    label: "Settings",
    icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  },
];
/** Sidebar groups (Add entry is a button above them; Settings sits at the bottom). */
const SIDEBAR: { title?: string; items: string[] }[] = [
  { title: "Money", items: ["/", "/todo", "/transactions", "/files", "/statement", "/categories", "/recurring"] },
  { title: "Taxes", items: ["/reports", "/occupancy"] },
];
const MOBILE_NAV = ["/", "/transactions", "/add", "/todo"];
/** Everything else on a phone lives behind the bottom bar's "More" button. */
const MOBILE_MORE = ["/files", "/reports", "/statement", "/categories", "/recurring", "/occupancy", "/settings"];
const MORE_ICON = "M5 12h.01M12 12h.01M19 12h.01";

export function Icon({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

function Shell() {
  const { user, logout: signOut, canWrite } = useSession();
  const outbox = useOutbox();
  const logout = async () => {
    const n = outbox.entries.length;
    if (
      n &&
      !confirm(
        `${n} saved-offline ${n === 1 ? "entry hasn't" : "entries haven't"} synced yet. They stay on this device and send when you sign in again. Sign out anyway?`,
      )
    )
      return;
    await signOut();
  };
  const todo = useApi<TodoSummary>("todo");
  const loc = useLocation();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MOBILE_MORE.some((to) => loc.pathname.startsWith(to));
  useEffect(() => {
    setMoreOpen(false);
    void todo.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  // Keyboard shortcut: "n" opens quick add from anywhere (outside inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        e.key === "n" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !/INPUT|TEXTAREA|SELECT/.test(t.tagName) &&
        !t.isContentEditable
      ) {
        e.preventDefault();
        void navigate("/add");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  // Refresh the badge when something is fixed on the To do page.
  useEffect(() => {
    const onChange = () => void todo.reload();
    window.addEventListener("todo:changed", onChange);
    return () => window.removeEventListener("todo:changed", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const badge = (to: string) =>
    to === "/todo" && todo.data?.total ? <span className="nav-count">{todo.data.total}</span> : null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>Rental Ledger</span>
        </div>
        {canWrite && (
          <NavLink to="/add" className="btn primary block sidebar-add">
            <Icon d="M12 5v14M5 12h14" size={18} /> Add entry
          </NavLink>
        )}
        <nav>
          {SIDEBAR.map((g) => (
            <div key={g.title} className="nav-group">
              {g.title && <div className="nav-title">{g.title}</div>}
              {g.items.map((to) => {
                const n = NAV.find((x) => x.to === to)!;
                return (
                  <NavLink key={to} to={to} end={to === "/"}>
                    <Icon d={n.icon} />
                    <span>{n.label}</span>
                    {badge(to)}
                  </NavLink>
                );
              })}
            </div>
          ))}
          <div className="nav-spacer" />
          <NavLink to="/settings">
            <Icon d={NAV.find((x) => x.to === "/settings")!.icon} />
            <span>Settings</span>
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          <div className="who" title={user.email}>
            {user.name || user.email}
            <small>{user.role}</small>
          </div>
          <button className="link" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        <SyncBanner />
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/months/:ym" element={<MonthPage />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/recurring" element={<RecurringPage />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/add" element={canWrite ? <AddEntry /> : <Navigate to="/" />} />
          <Route path="/todo" element={<Todo />} />
          <Route path="/review" element={<Navigate to="/todo" replace />} />
          <Route path="/occupancy" element={<Occupancy />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/import" element={<ImportCsv />} />
          <Route path="/files" element={<Files />} />
          <Route path="/statement" element={<ManagerStatement />} />
          <Route path="/statement/:month" element={<ManagerStatement />} />
          <Route path="/settings/*" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
      <nav className="bottom-nav">
        {MOBILE_NAV.map((to) => NAV.find((n) => n.to === to)!)
          .filter((n) => canWrite || n.to !== "/add")
          .map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={n.primary ? "nav-primary" : undefined}
              aria-label={n.label}
            >
              <Icon d={n.icon} size={n.primary ? 26 : 22} />
              {!n.primary && <span>{n.label}</span>}
              {badge(n.to)}
            </NavLink>
          ))}
        <button
          type="button"
          className={moreActive ? "active" : undefined}
          aria-label="More"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <Icon d={MORE_ICON} size={22} />
          <span>More</span>
        </button>
      </nav>
      {moreOpen && (
        <Modal title="More" onClose={() => setMoreOpen(false)}>
          <nav className="more-menu">
            {MOBILE_MORE.map((to) => {
              const n = NAV.find((x) => x.to === to)!;
              return (
                <NavLink key={to} to={to} onClick={() => setMoreOpen(false)}>
                  <Icon d={n.icon} />
                  <span>{n.label}</span>
                </NavLink>
              );
            })}
          </nav>
          <div className="more-foot">
            <div className="who" title={user.email}>
              {user.name || user.email}
              <small>{user.role}</small>
            </div>
            <button className="link" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const cfg = useApi<{ needs_setup: boolean; password_login: boolean; oidc: { name: string } | null }>("auth/config");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() => new URLSearchParams(location.search).get("error"));
  const [busy, setBusy] = useState(false);
  if (!cfg.data) return <div className="boot">Loading…</div>;
  const setup = cfg.data.needs_setup;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(setup ? "auth/setup" : "auth/login", { method: "POST", json: { email, password, name } });
      history.replaceState(null, "", "/");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>Rental Ledger</span>
        </div>
        <h1>{setup ? "Create the admin account" : "Sign in"}</h1>
        {setup && <p className="muted">No accounts exist yet. The first account becomes the administrator.</p>}
        {error && <div className="alert error">{error}</div>}
        {cfg.data.oidc && !setup && (
          <>
            <a className="btn primary block" href="/api/auth/oidc/start">
              Sign in with {cfg.data.oidc.name}
            </a>
            {cfg.data.password_login && <div className="divider">or</div>}
          </>
        )}
        {(cfg.data.password_login || setup) && (
          <>
            {setup && (
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
            )}
            <label>
              Email
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </label>
            <label>
              Password
              <input
                type="password"
                required
                minLength={setup ? 10 : 1}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={setup ? "new-password" : "current-password"}
              />
            </label>
            <button className="btn primary block" disabled={busy}>
              {busy ? "…" : setup ? "Create account" : "Sign in"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
