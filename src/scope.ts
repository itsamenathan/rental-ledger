import type { Property } from "./api.ts";

/** URL helpers for the property scope (/<property slug>/… or /all/…, inside the portfolio's basename); see property.tsx. */

/** First path segment after /<property>/ of the pages that also work on every property added up. */
export const ALL_PAGES = new Set(["", "months", "categories", "recurring", "transactions", "todo", "files"]);

/** The property a URL segment names: its slug, or an old numeric id. */
export const propertyFor = (properties: Property[], seg: string | null | undefined) =>
  seg ? properties.find((p) => p.slug === seg || String(p.id) === seg) : undefined;

/** App path → the same page under property segment `seg` (a property's slug, or "all"); /settings stays. */
export function scopePath(seg: string, to: string) {
  if (!to.startsWith("/") || to === "/settings" || to.startsWith("/settings/") || to.startsWith("/settings?"))
    return to;
  if (to === "/") return `/${seg}`;
  if (to.startsWith("/?") || to.startsWith("/#")) return `/${seg}${to.slice(1)}`;
  return `/${seg}${to}`;
}

export const propertySettingsPath = (slug: string) => `/${slug}/settings`;
