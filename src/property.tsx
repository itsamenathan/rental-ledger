/**
 * Property scope: every app page lives under /p/<property id>/… (or /p/all/… for the pages that can add up every
 * property). The shell reads the scope from the URL; pages get it from useProperty() and build links with
 * useScopedPath(). App-wide settings stay at /settings.
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { matchPath, Navigate, useLocation, useNavigate, useParams } from "react-router";
import type { Property } from "./api.ts";
import { PropertyCtx, useProperty, useSession, type PropertyScope } from "./hooks.ts";
import { ALL_PAGES, scopePath } from "./scope.ts";

const SCOPE_KEY = "property-scope";
const LAST_KEY = "property-last";
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

/**
 * The scope to use when the URL doesn't say: the last one opened, else the first active property. Archived
 * properties open by URL but never become the default.
 */
function remembered(properties: Property[]) {
  const active = properties.filter((p) => !p.archived);
  const known = (k: string | null): k is string => k != null && active.some((p) => String(p.id) === k);
  const last = read(LAST_KEY);
  const single = known(last) ? Number(last) : ((active[0] ?? properties[0])?.id ?? 0);
  const many = active.length > 1;
  const stored = read(SCOPE_KEY);
  const key = stored === "all" && many ? "all" : known(stored) ? stored : String(single);
  return { key, single, many };
}

export function PropertyProvider({ children }: { children: ReactNode }) {
  const { overview } = useSession();
  const { pathname } = useLocation();
  const urlKey = matchPath("/p/:key/*", pathname)?.params.key ?? null;
  const value = useMemo<PropertyScope>(() => {
    const d = remembered(overview.properties);
    const inUrl = overview.properties.find((p) => String(p.id) === urlKey);
    const key = inUrl ? String(inUrl.id) : urlKey === "all" && d.many ? "all" : d.key;
    const property = key === "all" ? null : (overview.properties.find((p) => String(p.id) === key) ?? null);
    const id = property?.id ?? null;
    return {
      key,
      id,
      property,
      single: id ?? d.single,
      many: d.many,
      qs: `property_id=${key}`,
      path: (to: string) => scopePath(key, to),
    };
  }, [overview.properties, urlKey]);
  useEffect(() => {
    if (urlKey !== value.key) return; // only remember a scope that was actually opened
    write(SCOPE_KEY, value.key);
    if (value.id != null) write(LAST_KEY, String(value.id));
  }, [urlKey, value.key, value.id]);
  return <PropertyCtx.Provider value={value}>{children}</PropertyCtx.Provider>;
}

/**
 * Wraps the /p/:key/* routes: an unknown property goes to the remembered one, and a page that needs one property
 * opened in the all-properties view goes to the last property used.
 */
export function ScopeGuard({ children }: { children: ReactNode }) {
  const scope = useProperty();
  const { overview } = useSession();
  const params = useParams();
  const loc = useLocation();
  if (!overview.properties.length) return <Navigate to="/settings/properties" replace />;
  const rest = params["*"] ?? "";
  const want = scope.key === "all" && !ALL_PAGES.has(rest.split("/")[0]!) ? String(scope.single) : scope.key;
  if (params.key !== want)
    return <Navigate to={`/p/${want}${rest ? `/${rest}` : ""}${loc.search}${loc.hash}`} replace />;
  return children;
}

/** Old (pre-property) URLs: /transactions?… → /p/<property>/transactions?… */
export function LegacyRedirect() {
  const scope = useProperty();
  const loc = useLocation();
  const path = loc.pathname === "/review" ? "/todo" : loc.pathname;
  return <Navigate to={`${scope.path(path)}${loc.search}${loc.hash}`} replace />;
}

/** The one property picker, in the shell. Hidden while there is only one active property. */
export function PropertySwitcher({ className }: { className?: string }) {
  const scope = useProperty();
  const { overview } = useSession();
  const navigate = useNavigate();
  const loc = useLocation();
  // With one active property it shows only while an archived one is open, as the way back.
  if (!scope.many && !scope.property?.archived) return null;
  const options = overview.properties.filter((p) => !p.archived || p.id === scope.id);
  const go = (key: string) => {
    const rest = matchPath("/p/:key/*", loc.pathname)?.params["*"] ?? "";
    // Stay on the same page (and filters) when it exists for the new choice, else open its overview.
    const keep = key !== "all" || ALL_PAGES.has(rest.split("/")[0]!);
    void navigate(keep && rest ? `/p/${key}/${rest}${loc.search}` : `/p/${key}`);
  };
  return (
    <select
      className={`property-switcher ${className ?? ""}`}
      value={scope.key}
      onChange={(e) => go(e.target.value)}
      aria-label="Property"
    >
      {options.map((p) => (
        <option key={p.id} value={String(p.id)}>
          {p.name}
          {p.archived ? " (archived)" : ""}
        </option>
      ))}
      {scope.many && <option value="all">All properties</option>}
    </select>
  );
}
