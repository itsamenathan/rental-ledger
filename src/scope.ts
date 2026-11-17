/** URL helpers for the property scope (/p/<id>/… or /p/all/…); see property.tsx. */

/** First path segment after /p/<key>/ of the pages that also work on every property added up. */
export const ALL_PAGES = new Set(["", "months", "categories", "recurring", "transactions", "todo", "files"]);

export function scopePath(key: string, to: string) {
  if (!to.startsWith("/") || to.startsWith("/settings") || to.startsWith("/p/")) return to;
  if (to === "/") return `/p/${key}`;
  if (to.startsWith("/?") || to.startsWith("/#")) return `/p/${key}${to.slice(1)}`;
  return `/p/${key}${to}`;
}

export const propertySettingsPath = (id: number) => `/p/${id}/settings`;
