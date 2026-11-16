import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, type Category, type Overview, type User } from "./api.ts";
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

export function usePersistentState<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
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
