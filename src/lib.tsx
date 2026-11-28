import { startTransition, useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Overview, type User, type UserSettings } from "./api.ts";
import { money, THIS_YEAR } from "./format.ts";
import {
  ConfirmCtx,
  SessionCtx,
  ToastCtx,
  useSession,
  type ConfirmOptions,
  type Session,
  type Toast,
} from "./hooks.ts";

// ---------------- session + reference data ----------------

export function SessionProvider({
  user,
  canWrite,
  portfolio,
  portfolios,
  settings: initialSettings,
  onLogout,
  children,
}: {
  user: User;
  canWrite: boolean;
  portfolio: Session["portfolio"];
  portfolios: Session["portfolios"];
  settings: UserSettings;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [settings, setSettings] = useState(initialSettings);
  const updateSettings = useCallback(async (patch: Partial<UserSettings>) => {
    setSettings(await api<UserSettings>("auth/settings", { method: "PATCH", json: patch }));
    // The service worker keeps the last "who am I" for offline starts; refresh it so a reload offline keeps the choice.
    void api("auth/me").catch(() => undefined);
  }, []);
  const reloadOverview = useCallback(async (then?: () => void) => {
    const next = await api<Overview>("overview");
    if (!then) return setOverview(next);
    // One render for the new list and `then` (a navigation): a property's changed web address must never be seen
    // with the old URL, or the page would take it for an unknown address and redirect.
    startTransition(() => {
      setOverview(next);
      then();
    });
  }, []);
  const boot = useCallback(() => api<Overview>("overview").then(setOverview, (e: Error) => setFailed(e.message)), []);
  useEffect(() => {
    void boot();
  }, [boot]);
  if (!overview)
    return failed ? (
      <div className="boot">
        <p>Can't reach the server ({failed}).</p>
        <button
          className="btn"
          onClick={() => {
            setFailed(null);
            void boot();
          }}
        >
          Try again
        </button>
      </div>
    ) : (
      <div className="boot">Loading…</div>
    );
  const value: Session = {
    user,
    canWrite,
    portfolio,
    portfolios,
    settings,
    updateSettings,
    overview,
    reloadOverview,
    category: (id) => overview.categories.find((c) => c.id === id),
    logout: async () => {
      await api("auth/logout", { method: "POST" });
      // The service worker keeps the last "who am I" / overview for offline starts; drop them with the session.
      await globalThis.caches?.delete("api-v1").catch(() => false);
      onLogout();
    },
  };
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

// ---------------- toasts ----------------

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Math.random();
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.action ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                className="link"
                onClick={() => {
                  t.action!.run();
                  setToasts((ts) => ts.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------- confirm dialog ----------------

/** The app's own "are you sure?" (the browser's looks out of place, most of all on a phone). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<(ConfirmOptions & { done: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((done) => setAsk({ ...o, done })), []);
  const close = (ok: boolean) => {
    ask?.done(ok);
    setAsk(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {ask && (
        <Modal title={ask.title ?? "Are you sure?"} onClose={() => close(false)}>
          <p className="confirm-text">{ask.message}</p>
          <div className="modal-actions">
            {/* focus starts on the safe choice when the action removes something */}
            <button className="btn" onClick={() => close(false)} autoFocus={ask.danger}>
              Cancel
            </button>
            <button
              className={`btn ${ask.danger ? "danger" : "primary"}`}
              onClick={() => close(true)}
              autoFocus={!ask.danger}
            >
              {ask.confirm}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

// ---------------- small UI bits ----------------

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Amount({ value, kind }: { value: number; kind?: "income" | "expense" }) {
  const cls = value > 0 ? "pos" : value < 0 ? "neg" : "";
  return (
    <span className={`amount ${cls}`} title={kind}>
      {money(value)}
    </span>
  );
}

export function AllocationBadge({ value }: { value: "direct" | "indirect" | null }) {
  if (!value) return <span className="badge muted">—</span>;
  return <span className={`badge ${value}`}>{value === "direct" ? "Direct" : "Indirect"}</span>;
}

export function YearSelect({ value, onChange }: { value: number; onChange: (y: number) => void }) {
  const { overview } = useSession();
  const now = THIS_YEAR;
  const years = [...new Set([now, ...overview.years])].sort((a, b) => b - a);
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label="Year">
      {years.map((y) => (
        <option key={y}>{y}</option>
      ))}
    </select>
  );
}
