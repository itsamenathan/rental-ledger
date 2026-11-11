import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Overview, type User } from "./api.ts";
import { money, THIS_YEAR } from "./format.ts";
import { SessionCtx, ToastCtx, useSession, type Session, type Toast } from "./hooks.ts";

// ---------------- session + reference data ----------------

export function SessionProvider({
  user,
  canWrite,
  onLogout,
  children,
}: {
  user: User;
  canWrite: boolean;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const reloadOverview = useCallback(async () => setOverview(await api<Overview>("overview")), []);
  useEffect(() => {
    void reloadOverview();
  }, [reloadOverview]);
  if (!overview) return <div className="boot">Loading…</div>;
  const value: Session = {
    user,
    canWrite,
    overview,
    reloadOverview,
    category: (id) => overview.categories.find((c) => c.id === id),
    logout: async () => {
      await api("auth/logout", { method: "POST" });
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
