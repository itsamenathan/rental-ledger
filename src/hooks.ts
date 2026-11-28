import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  api,
  type Category,
  type Overview,
  type PortfolioRef,
  type Property,
  type Role,
  type User,
  type UserSettings,
} from "./api.ts";
import type { OutboxEntry } from "./outbox.ts";
import { THIS_YEAR } from "./format.ts";
import { scopePath } from "./scope.ts";

// ---------------- session + reference data ----------------

export interface Session {
  user: User;
  canWrite: boolean;
  /** This page's portfolio (`viewing`: the server's administrator looking in, read-only) */
  portfolio: { slug: string; name: string; role: Role; viewing: boolean };
  /** Every portfolio this login belongs to */
  portfolios: PortfolioRef[];
  /** The signed-in person's own preferences (every key has a value) */
  settings: UserSettings;
  /** Save some preferences; rejects (message for a toast) when the server can't be reached or refuses */
  updateSettings: (patch: Partial<UserSettings>) => Promise<void>;
  overview: Overview;
  /** Fetch the overview again; `then` runs in the same render (e.g. a navigation that needs the new list) */
  reloadOverview: (then?: () => void) => Promise<void>;
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

/** A question before something that can't be undone; anything that can be undone acts at once and offers Undo. */
export interface ConfirmOptions {
  title?: string;
  message: string;
  /** the button that goes ahead, e.g. "Revoke key" */
  confirm: string;
  /** red button: something is deleted or stops working */
  danger?: boolean;
}
export const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async (o) =>
  window.confirm(o.message),
);
/** `if (!(await confirm({ message, confirm: "Remove" }))) return;` shows the app's own dialog, not the browser's. */
export const useConfirm = () => useContext(ConfirmCtx);

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

// ---------------- property scope (from the URL: /<property slug>/… or /all/…) ----------------

export interface PropertyScope {
  /** Sent as property_id and remembered: a property id, or "all" */
  key: string;
  /** In the URL: the property's slug, or "all" */
  segment: string;
  /** The property id, or null in the all-properties view */
  id: number | null;
  property: Property | null;
  /** A single property for things that need one: the current one, else the one used last */
  single: number;
  /** That property's own settings page */
  settingsPath: string;
  /** More than one active property (otherwise the app hides the switcher) */
  many: boolean;
  /** Query parameter for API calls: `property_id=<key>` */
  qs: string;
  /** App path → the same page for this property ("/transactions?x" → "/harbor-view/transactions?x"); /settings stays */
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

/** Link helper for one property's pages whatever scope is showing: `at(tx.property_id, "/months/2026-10")`. */
export function usePropertyPath() {
  const { properties } = useSession().overview;
  return useCallback(
    (propertyId: number, to: string) =>
      scopePath(properties.find((p) => p.id === propertyId)?.slug ?? String(propertyId), to),
    [properties],
  );
}

/** Edits, deletes and receipts saved offline and not yet synced, by entry id (new entries have no row yet). */
export function usePendingByEntry(): Map<number, string> {
  const outbox = useOutbox();
  return new Map(outbox.entries.filter((e) => e.tx_id != null && e.op !== "create").map((e) => [e.tx_id!, e.op]));
}

/** Select mode for a list of rows: on/off, the ticked ids, and the `select` part of a RowCtx. */
export function useTxSelection() {
  const [on, setOn] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return {
    on,
    selected,
    setSelected,
    start: () => setOn(true),
    stop: () => {
      setOn(false);
      setSelected(new Set());
    },
    ctx: on ? { selected, toggle } : undefined,
  };
}
export type TxSelection = ReturnType<typeof useTxSelection>;

/**
 * The year you're working in, shared by Overview, Categories, Occupancy, Transactions and the Manager list, so
 * picking 2025 on one page carries to the next. The tax report keeps its own (it starts at last year on purpose).
 * `opened` (a link's ?year=) wins and becomes the shared year. Kept under the Overview's old key, so it's not lost.
 */
export function useWorkingYear(opened?: number) {
  return usePersistentState("dash-year", THIS_YEAR, opened && opened > 1900 ? opened : undefined);
}
