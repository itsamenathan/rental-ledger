/**
 * Property scope: every app page lives under /<property slug>/… (or /all/… for the pages that can add up every
 * property), inside the portfolio's /<portfolio slug>/ basename. The shell reads the scope from the URL; pages get it from
 * useProperty() and build links with useScopedPath(). The portfolio's settings stay at /settings. A numeric segment is an
 * old property id (from /p/<id>/… links) and is redirected to the slug.
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { matchPath, Navigate, useLocation, useNavigate, useParams } from "react-router";
import type { Property } from "./api.ts";
import { PropertyCtx, useProperty, useSession, type PropertyScope } from "./hooks.ts";
import { ALL_PAGES, propertyFor, propertySettingsPath, scopePath } from "./scope.ts";
import { openPortfolio, portfolioKey } from "./portfolio.ts";

// Per portfolio: property ids belong to one portfolio.
const SCOPE_KEY = portfolioKey("property-scope");
const LAST_KEY = portfolioKey("property-last");
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

/** The URL segment for a scope key (an id or "all"). */
const segmentFor = (properties: Property[], key: string) =>
  key === "all" ? "all" : (properties.find((p) => String(p.id) === key)?.slug ?? key);

export function PropertyProvider({ children }: { children: ReactNode }) {
  const { overview } = useSession();
  const { pathname } = useLocation();
  const urlSeg = matchPath("/:seg/*", pathname)?.params.seg ?? null;
  const inUrl = propertyFor(overview.properties, urlSeg);
  const urlKey = inUrl ? String(inUrl.id) : urlSeg === "all" ? "all" : null;
  const value = useMemo<PropertyScope>(() => {
    const d = remembered(overview.properties);
    const key = urlKey && (urlKey !== "all" || d.many) ? urlKey : d.key;
    const property = key === "all" ? null : (overview.properties.find((p) => String(p.id) === key) ?? null);
    const id = property?.id ?? null;
    const segment = segmentFor(overview.properties, key);
    const single = id ?? d.single;
    return {
      key,
      segment,
      id,
      property,
      single,
      settingsPath: propertySettingsPath(segmentFor(overview.properties, String(single))),
      many: d.many,
      qs: `property_id=${key}`,
      path: (to: string) => scopePath(segment, to),
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
 * Wraps the /:seg/* routes. An old id goes to the property's slug; a segment that is no property is an old page
 * address (/transactions?…) and goes to that page of the remembered property; and a page that needs one property
 * opened in the all-properties view goes to the last property used.
 */
export function ScopeGuard({ children }: { children: ReactNode }) {
  const scope = useProperty();
  const { overview } = useSession();
  const params = useParams();
  const loc = useLocation();
  if (!overview.properties.length) return <Navigate to="/settings/properties" replace />;
  const seg = params.seg ?? "";
  if (seg !== "all" && !propertyFor(overview.properties, seg)) return <LegacyRedirect />;
  const rest = params["*"] ?? "";
  const want =
    scope.key === "all" && !ALL_PAGES.has(rest.split("/")[0]!)
      ? segmentFor(overview.properties, String(scope.single))
      : scope.segment;
  if (seg !== want) return <Navigate to={`/${want}${rest ? `/${rest}` : ""}${loc.search}${loc.hash}`} replace />;
  return children;
}

/**
 * Old addresses: /transactions?… (before properties) → /<property>/transactions?…, and /p/<id>/… (before readable
 * slugs) → /<that property's slug>/….
 */
export function LegacyRedirect() {
  const scope = useProperty();
  const loc = useLocation();
  const old = matchPath("/p/:seg/*", loc.pathname);
  const path = old
    ? `/${old.params.seg}${old.params["*"] ? `/${old.params["*"]}` : ""}`
    : scope.path(loc.pathname === "/review" ? "/todo" : loc.pathname);
  return <Navigate to={`${path}${loc.search}${loc.hash}`} replace />;
}

/**
 * The one picker in the shell: this property (or all of them), and, for someone with other portfolios, those too
 * (opening one is a full page load into it). Hidden while there's nothing to choose.
 */
export function PropertySwitcher({ className }: { className?: string }) {
  const scope = useProperty();
  const { overview, portfolio, portfolios } = useSession();
  const navigate = useNavigate();
  const loc = useLocation();
  const otherPortfolios = portfolios.filter((p) => !p.archived && p.slug !== portfolio.slug);
  // With one active property it shows only while an archived one is open, as the way back.
  if (!scope.many && !scope.property?.archived && !otherPortfolios.length) return null;
  const options = overview.properties.filter((p) => !p.archived || p.id === scope.id);
  const go = (key: string) => {
    if (key.startsWith("portfolio:")) return openPortfolio(key.slice("portfolio:".length));
    const rest = matchPath("/:seg/*", loc.pathname)?.params["*"] ?? "";
    const seg = segmentFor(overview.properties, key);
    // Stay on the same page (and filters) when it exists for the new choice, else open its overview.
    const keep = key !== "all" || ALL_PAGES.has(rest.split("/")[0]!);
    void navigate(keep && rest ? `/${seg}/${rest}${loc.search}` : `/${seg}`);
  };
  const here = (
    <>
      {options.map((p) => (
        <option key={p.id} value={String(p.id)}>
          {p.name}
          {p.archived ? " (archived)" : ""}
        </option>
      ))}
      {scope.many && <option value="all">All properties</option>}
    </>
  );
  return (
    <select
      className={`property-switcher ${className ?? ""}`}
      value={scope.key}
      onChange={(e) => go(e.target.value)}
      aria-label={otherPortfolios.length ? "Property or portfolio" : "Property"}
    >
      {otherPortfolios.length ? (
        <>
          <optgroup label={`${portfolio.name}${portfolio.viewing ? " (looking in)" : ""}`}>{here}</optgroup>
          <optgroup label="Other portfolios">
            {otherPortfolios.map((b) => (
              <option key={b.slug} value={`portfolio:${b.slug}`}>
                {b.name}
              </option>
            ))}
          </optgroup>
        </>
      ) : (
        here
      )}
    </select>
  );
}
