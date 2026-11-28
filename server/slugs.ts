/**
 * Readable web addresses: /<portfolio>/<property>/<page>, e.g. /alexs-portfolio/harbor-view/occupancy.
 *
 * Shared by the server (which makes and checks slugs) and the app (which reads them from the URL), so both agree on
 * which first path segments are the app's own and can never be a portfolio. Plain TypeScript, no imports: the
 * Docker image only carries server/, and src/ imports this file.
 *
 * A slug is not a secret: every request checks membership, so knowing a slug gives nothing.
 */

/**
 * First path segments that are never a portfolio: server routes, built files, the sign-in and invite pages, and
 * the app's own pages (old links without a portfolio, /transactions or /p/1/…, are sent into the last one used).
 */
export const RESERVED_PORTFOLIO_SLUGS = new Set([
  // server and build output (server/main.ts, server/http/*, dist/)
  "api",
  "mcp",
  "assets",
  "icons",
  "favicon",
  "manifest",
  "sw",
  "health",
  "healthz",
  "metrics",
  "static",
  // pages outside any portfolio
  "invite",
  "login",
  "logout",
  "signup",
  "auth",
  "oauth",
  "admin",
  "new",
  "help",
  // old addresses (/p/<id>/…), and short words kept free for the app
  "p",
  "o",
  "b",
  // app pages (src/App.tsx routes), reachable without a portfolio in old links
  "all",
  "settings",
  "months",
  "categories",
  "recurring",
  "transactions",
  "add",
  "todo",
  "review",
  "calendar",
  "occupancy",
  "reports",
  "import",
  "files",
  "statement",
  "property",
]);

/** Second path segments that are the portfolio's own pages, never a property. */
export const RESERVED_PROPERTY_SLUGS = new Set(["all", "settings", "p"]);

const SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 40;

/** "Alex's Portfolio!" → "alexs-portfolio". May be empty; see `slugBase`. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/** A web-address field as it's typed: lowercase, spaces and underscores as dashes (a trailing dash may still follow). */
export const slugTyping = (value: string) => value.toLowerCase().replace(/[\s_]+/g, "-");

/** Why this slug can't be used, or null. `reserved` is RESERVED_PORTFOLIO_SLUGS or RESERVED_PROPERTY_SLUGS. */
export function slugProblem(slug: string, reserved: Set<string>): string | null {
  if (!slug) return "Pick a web address";
  if (slug.length > SLUG_MAX) return `Keep the web address to ${SLUG_MAX} characters`;
  if (!SHAPE.test(slug)) return "Use lowercase letters, numbers and dashes";
  // A bare number is read as an old property id.
  if (!/[a-z]/.test(slug)) return "Include at least one letter";
  if (reserved.has(slug)) return `"${slug}" is used by the app; pick another`;
  return null;
}

/**
 * A free slug for this name: the name's slug, or `fallback` when that is empty, numeric or reserved, then -2, -3…
 * until `taken` says no.
 */
export function uniqueSlug(
  name: string,
  reserved: Set<string>,
  taken: (slug: string) => boolean,
  fallback: string,
): string {
  let base = slugify(name);
  if (slugProblem(base, reserved)) base = base && /[a-z]/.test(base) ? `${fallback}-${base}` : fallback;
  base = base.slice(0, SLUG_MAX - 4).replace(/-+$/, "");
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}
