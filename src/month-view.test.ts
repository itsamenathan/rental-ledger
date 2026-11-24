import { describe, expect, it } from "vite-plus/test";
import {
  applyView,
  exportFilters,
  matchesSearch,
  readView,
  txParts,
  viewSearch,
  withView,
  type Tx,
} from "./month-view.ts";

const tx = (id: number, over: Partial<Tx>): Tx =>
  ({
    id,
    date: "2026-11-05",
    amount: -10,
    category_id: 1,
    category: "Utilities",
    kind: "expense",
    subcategory: "",
    vendor: "",
    description: "",
    reference: "",
    needs_review: false,
    needs_receipt: false,
    ...over,
  }) as Tx;

const items = [
  tx(1, { vendor: "Example Fiber", subcategory: "Internet", amount: -79.99 }),
  tx(2, { vendor: "Airbnb", category: "Rental Income", category_id: 2, kind: "income", amount: 767.84 }),
  tx(3, { vendor: "Warehouse Club", amount: -112.64, needs_receipt: true, needs_review: true }),
];

describe("month view in the URL", () => {
  it("reads defaults and ignores junk", () => {
    expect(readView(new URLSearchParams("show=bogus&cat=x&view=huh"))).toEqual({
      show: "all",
      q: "",
      cat: null,
      sort: "asc",
      layout: null,
    });
  });

  it("writes only what differs from the defaults", () => {
    let p = withView(new URLSearchParams("record=1"), { show: "expense", sort: "desc" });
    expect(p.toString()).toBe("record=1&show=expense&sort=desc");
    p = withView(p, { show: "all", sort: "asc" });
    expect(p.toString()).toBe("record=1");
    expect(viewSearch(new URLSearchParams("record=1&show=income&q=air"))).toBe("?show=income&q=air");
    expect(viewSearch(new URLSearchParams("record=1"))).toBe("");
  });
});

describe("filtering", () => {
  it("filters by kind, flags and receipts", () => {
    const ids = (show: "income" | "expense" | "review" | "receipt") =>
      applyView(items, { ...readView(new URLSearchParams()), show }).map((t) => t.id);
    expect(ids("income")).toEqual([2]);
    expect(ids("expense")).toEqual([1, 3]);
    expect(ids("review")).toEqual([3]);
    expect(ids("receipt")).toEqual([3]);
  });

  it("searches text, category, entry number and amounts like the API", () => {
    expect(matchesSearch(items[0]!, "fiber")).toBe(true);
    expect(matchesSearch(items[1]!, "rental")).toBe(true);
    expect(matchesSearch(items[0]!, "3")).toBe(false);
    expect(matchesSearch(items[2]!, "3")).toBe(true); // entry #3
    expect(matchesSearch(items[0]!, "$79.99")).toBe(true);
    expect(matchesSearch(items[0]!, "79")).toBe(true); // 79.00–79.99
    expect(matchesSearch(items[0]!, "80")).toBe(false);
    expect(matchesSearch(items[0]!, "79.9")).toBe(false); // one decimal is exact, like the API
  });

  it("narrows by category and flips the order", () => {
    const v = withView(new URLSearchParams(), { cat: 1, sort: "desc" });
    expect(applyView(items, readView(v)).map((t) => t.id)).toEqual([3, 1]);
  });

  it("sends the same view to the CSV export", () => {
    expect(exportFilters(readView(new URLSearchParams("show=receipt&q=%20club&cat=1&sort=desc")))).toEqual({
      kind: undefined,
      needs_review: undefined,
      needs_receipt: "true",
      category: "1",
      q: "club",
      sort: "date_desc",
    });
  });
});

describe("entry names", () => {
  it("drops repeats", () => {
    expect(
      txParts({ vendor: "Airbnb", subcategory: "airbnb", description: "4-night stay", category: "Rental Income" }),
    ).toEqual({
      main: "Airbnb",
      rest: ["4-night stay"],
      hasName: true,
    });
    expect(txParts({ vendor: "", subcategory: "", description: "", category: "Mortgage" })).toEqual({
      main: "Mortgage",
      rest: [],
      hasName: false,
    });
  });
});
