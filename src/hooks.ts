import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, type Category, type Overview, type Property, type User } from "./api.ts";
import type { OutboxEntry } from "./outbox.ts";

// ---------------- session + reference data ----------------

export interface Session {
  user: User;
  canWrite: boolean;
  overview: Overview;
  reloadOverview: () => Promise<void>;
  category: (id: number) => Category | undefined;
  logout: () => Promise<void>;
}

export const SessionCtx = createContext<Session | null>(null);
export const useSession = () => {
  const s = useContext(SessionCtx);
  if (!s) throw new Error("No session");
  return s;
};

// ---------------- data hook ----------------

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

// ---------------- toasts ----------------

export type Toast = { id: number; text: string; kind: "ok" | "error"; action?: { label: string; run: () => void } };
export const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

// ---------------- persisted UI state ----------------

/** `opened`, when given (e.g. from a link's ?month=), wins over the saved value and becomes the new one. */
export function usePersistentState<T>(key: string, initial: T, opened?: T) {
  const [v, setV] = useState<T>(() => {
    if (opened !== undefined) return opened;
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  }, [key, v]);
  return [v, setV] as const;
}

// ---------------- offline outbox ----------------

export interface OutboxState {
  entries: OutboxEntry[];
  online: boolean;
  syncing: boolean;
  syncNow: () => void;
}
export const OutboxCtx = createContext<OutboxState>({
  entries: [],
  online: true,
  syncing: false,
  syncNow: () => {},
});
export const useOutbox = () => useContext(OutboxCtx);

// ---------------- property scope (from the URL: /p/<id>/… or /p/all/…) ----------------

export interface PropertyScope {
  /** What's in the URL and sent as property_id: a property id, or "all" */
  key: string;
  /** The property id, or null in the all-properties view */
  id: number | null;
  property: Property | null;
  /** A single property for things that need one: the current one, else the one used last */
  single: number;
  /** More than one active property (otherwise the app hides the switcher) */
  many: boolean;
  /** Query parameter for API calls: `property_id=<key>` */
  qs: string;
  /** App path → the same page for this property ("/transactions?x" → "/p/3/transactions?x"); /settings stays */
  path: (to: string) => string;
}

export const PropertyCtx = createContext<PropertyScope | null>(null);
export const useProperty = () => {
  const s = useContext(PropertyCtx);
  if (!s) throw new Error("No property scope");
  return s;
};
/** Link helper: `to={scoped("/months/2026-10")}`. */
export const useScopedPath = () => useProperty().path;
