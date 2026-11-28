/**
 * Which portfolio (several properties together) this page is in: the app runs under /<slug>/… (React Router's basename), and every
 * API call carries ?portfolio=<slug> (`apiUrl`). Switching portfolios is a full page load, so nothing held in memory
 * from one portfolio shows in another. See docs/plans/portfolios.md.
 */
import { RESERVED_PORTFOLIO_SLUGS } from "../server/slugs.ts";

/** The portfolio named by a path's first segment, or null when it's one of the app's own (server/slugs.ts). */
export function portfolioInPath(pathname: string): string | null {
  const first = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\/|$)/.exec(pathname)?.[1];
  return first && !RESERVED_PORTFOLIO_SLUGS.has(first) ? first : null;
}

/** This page's portfolio, from the URL; null outside one (boot, invite and sign-in pages, old links). */
export const PORTFOLIO_SLUG: string | null =
  typeof location === "undefined" ? null : portfolioInPath(location.pathname);

/** React Router's basename for this page. */
export const BASENAME = PORTFOLIO_SLUG ? `/${PORTFOLIO_SLUG}` : undefined;

/**
 * An API URL in this page's portfolio. `slug` overrides it (null = none: the server then uses the login's only
 * portfolio, as outbox work saved before portfolios existed does).
 */
export function apiUrl(path: string, slug: string | null = PORTFOLIO_SLUG): string {
  const url = path.startsWith("/") ? path : `/api/${path}`;
  if (!slug || !url.startsWith("/api/") || url.startsWith("/api/auth/oidc")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}portfolio=${encodeURIComponent(slug)}`;
}

const LAST = "portfolio-last";
export function lastPortfolio(): string | null {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}
export function rememberPortfolio(slug: string) {
  try {
    localStorage.setItem(LAST, slug);
  } catch {
    /* storage unavailable */
  }
}

/** Stop opening this portfolio by default (access to it was lost). */
export function forgetPortfolio(slug: string | null = PORTFOLIO_SLUG) {
  try {
    if (slug && localStorage.getItem(LAST) === slug) localStorage.removeItem(LAST);
  } catch {
    /* storage unavailable */
  }
}

/** The portfolio's web address changed: keep what this browser remembers about it (`portfolioKey`s, last opened). */
export function movePortfolio(from: string, to: string) {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.endsWith(`:${from}`)) continue;
      localStorage.setItem(`${key.slice(0, -from.length)}${to}`, localStorage.getItem(key)!);
      localStorage.removeItem(key);
    }
    if (localStorage.getItem(LAST) === from) localStorage.setItem(LAST, to);
  } catch {
    /* storage unavailable */
  }
}

/** Fired by api() when the server says this page's portfolio is no longer open to the caller. */
export const PORTFOLIO_LOST_EVENT = "portfolio:lost";

/** Open another portfolio (a full page load). `path` is inside it, e.g. "/settings/people". */
export function openPortfolio(slug: string, path = "/") {
  location.assign(`/${slug}${path === "/" ? "" : path}`);
}

/** A localStorage key that belongs to this portfolio (remembered property, year…). */
export const portfolioKey = (key: string) => (PORTFOLIO_SLUG ? `${key}:${PORTFOLIO_SLUG}` : key);
