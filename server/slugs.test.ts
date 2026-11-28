/**
 * Readable web addresses (server/slugs.ts): a portfolio slug is the first path segment, so it must never be one of the
 * server's routes, a built file or an app page; the app reads the same list (src/portfolio.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { RESERVED_PORTFOLIO_SLUGS, RESERVED_PROPERTY_SLUGS, slugify, slugProblem, uniqueSlug } from "./slugs.ts";

const SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const first = (path: string) => path.split("/").filter(Boolean)[0] ?? "";

describe("slugs", () => {
  it("makes readable slugs from names", () => {
    expect(slugify("Alex's portfolio")).toBe("alexs-portfolio");
    expect(slugify("  Harbor View Cottage! ")).toBe("harbor-view-cottage");
    expect(slugify("Café & Bar")).toBe("cafe-and-bar");
    expect(slugify("***")).toBe("");
    expect(slugify("x".repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it("finds a free one, falling back for empty, numeric or reserved names", () => {
    const taken = new Set(["harbor-view", "harbor-view-2"]);
    expect(uniqueSlug("Harbor View", RESERVED_PROPERTY_SLUGS, (s) => taken.has(s), "property")).toBe("harbor-view-3");
    expect(uniqueSlug("123", RESERVED_PROPERTY_SLUGS, () => false, "property")).toBe("property");
    expect(uniqueSlug("All", RESERVED_PROPERTY_SLUGS, () => false, "property")).toBe("property-all");
    expect(uniqueSlug("API", RESERVED_PORTFOLIO_SLUGS, () => false, "portfolio")).toBe("portfolio-api");
  });

  it("refuses badly formed and reserved slugs", () => {
    expect(slugProblem("alexs-portfolio", RESERVED_PORTFOLIO_SLUGS)).toBeNull();
    for (const bad of ["", "Upper", "a--b", "-a", "a_b", "123", "api", "settings"])
      expect(slugProblem(bad, RESERVED_PORTFOLIO_SLUGS), bad).not.toBeNull();
  });

  it("reserves every server route, public file and app page", async () => {
    const { createApp } = await import("./app.ts");
    const names = new Set<string>(["assets"]);
    for (const r of createApp().routes) names.add(first(r.path));
    for (const f of readdirSync(new URL("../public", import.meta.url))) names.add(f);
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    for (const m of app.matchAll(/(?:path|to)[=:] ?"(\/[^"]*)"/g)) names.add(first(m[1]!));
    const missing = [...names].filter((n) => SHAPE.test(n) && !RESERVED_PORTFOLIO_SLUGS.has(n));
    expect(missing).toEqual([]);
  });
});
