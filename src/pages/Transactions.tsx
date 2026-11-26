import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { qs, type Transaction, type TxCounts, type TxList } from "../api.ts";
import TxEditModal from "../components/TxEditModal.tsx";
import { BulkBar, SelectToggle, TxRow, type RowCtx } from "../components/TxRows.tsx";
import { money, monthTitle } from "../format.ts";
import { useApi, usePendingByEntry, useSession, useProperty, useTxSelection, useWorkingYear } from "../hooks.ts";

const PAGE = 100;
/** Every filter the page sends to the API, so links from other pages (To do, Reports, Files…) keep working. */
const FILTER_KEYS = [
  "year",
  "month",
  "category",
  "kind",
  "allocation",
  "q",
  "amount",
  "min_amount",
  "max_amount",
  "needs_review",
  "has_attachment",
  "needs_receipt",
  "vendor",
] as const;
/** the filters behind the "Filters" button */
const MORE_KEYS = ["month", "category", "allocation", "amount", "min_amount", "max_amount", "has_attachment", "vendor"];

type Chip = "all" | "income" | "expense" | "review" | "receipt";
/** `count` = its number in the API's `counts`; optional chips hide when nothing would show, as on the Month page */
const CHIPS: { key: Chip; label: string; count: keyof TxCounts; optional?: boolean }[] = [
  { key: "all", label: "All", count: "all" },
  { key: "income", label: "Income", count: "income" },
  { key: "expense", label: "Expenses", count: "expense" },
  { key: "review", label: "Flagged", count: "needs_review", optional: true },
  { key: "receipt", label: "Needs receipt", count: "needs_receipt", optional: true },
];
const SORTS = [
  ["date_desc", "Newest first"],
  ["date_asc", "Oldest first"],
  ["amount_desc", "Largest first"],
  ["amount_asc", "Smallest first"],
  ["updated_desc", "Recently changed"],
] as const;

/**
 * Every entry, filtered and paged by the server. Rows look and behave like the Month page's list (same chips, search,
 * flag and receipt icons); this page adds the year, the filters the month list has no need for, select mode for
 * changing several entries at once, and month headings while the list is in date order.
 */
export default function Transactions() {
  const { path: scoped, key: propertyKey } = useProperty();
  const { overview, canWrite } = useSession();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [amount, setAmount] = useState(params.get("amount") ?? "");
  const sel = useTxSelection();
  const [editing, setEditing] = useState<number | null>(null);
  const pending = usePendingByEntry();

  // Default to the current year. ?year=all shows every year; a month filter implies its own year.
  const yearParam = params.get("year");
  const allYears = yearParam === "all";
  const filters: Record<string, string> = {
    ...Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ""])),
    property_id: propertyKey,
  };
  // with no year in the address, the shared working year (picked here or on Overview, Categories, Occupancy…)
  const [workingYear, setWorkingYear] = useWorkingYear();
  filters.year = allYears ? "" : yearParam || (filters.month ? "" : String(workingYear));
  const offset = Number(params.get("offset") ?? 0);
  const sort = params.get("sort") ?? "date_desc";
  const query = qs({ ...filters, limit: PAGE, offset, sort, counts: "true" });
  const { data, error, loading, reload } = useApi<TxList>(`transactions${query}`);

  const moreActive = MORE_KEYS.filter((k) => params.get(k)).length;
  const [moreOpen, setMoreOpen] = useState(moreActive > 0);

  // debounce the text boxes into the URL
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get("q") ?? "") !== search) set("q", search);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get("amount") ?? "") !== amount) set("amount", amount.trim());
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount]);

  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete("offset");
    setParams(next, { replace: true });
  }
  const set = (key: string, value: string) => update({ [key]: value });

  // Each chip lights up from its own filter, so a link that combines them (expenses that need a receipt) shows both;
  // picking a chip makes it the only one, like on the Month page.
  const chipOn: Record<Chip, boolean> = {
    income: filters.kind === "income",
    expense: filters.kind === "expense",
    review: filters.needs_review === "true",
    receipt: filters.needs_receipt === "true",
    all: false,
  };
  chipOn.all = !chipOn.income && !chipOn.expense && !chipOn.review && !chipOn.receipt;
  const pickChip = (c: Chip) =>
    update({
      kind: c === "income" || c === "expense" ? c : "",
      needs_review: c === "review" ? "true" : "",
      needs_receipt: c === "receipt" ? "true" : "",
    });

  const yearSel = allYears ? "all" : filters.year || (filters.month ?? "").slice(0, 4);
  const narrowed = FILTER_KEYS.some((k) => k !== "year" && params.get(k));
  const years = [...new Set([new Date().getFullYear(), ...overview.years])].sort((a, b) => b - a);
  const clear = () => {
    setSearch("");
    setAmount("");
    const next = new URLSearchParams();
    if (params.get("year")) next.set("year", params.get("year")!);
    if (params.get("sort")) next.set("sort", params.get("sort")!);
    setParams(next, { replace: true });
  };

  const ctx: RowCtx = {
    canWrite,
    showProperty: propertyKey === "all",
    onOpen: setEditing,
    onChanged: () => void reload(),
    pending,
    select: sel.ctx,
  };
  // in date order the page reads as months, each heading a link to that month's page
  const groups = sort.startsWith("date_") ? byMonth(data?.items ?? []) : [{ ym: "", items: data?.items ?? [] }];

  return (
    <div className="page">
      <header className="page-head">
        <h1>Transactions</h1>
        <div className="head-actions">
          <a className="btn" href={`/api/export/transactions.csv${qs({ ...filters, sort })}`}>
            Export CSV
          </a>
          {canWrite && (
            <Link className="btn" to={scoped("/import")}>
              Import CSV
            </Link>
          )}
          {canWrite && (
            <Link className="btn primary" to={scoped("/add")}>
              + Add
            </Link>
          )}
        </div>
      </header>

      <section className="card tx-card">
        <div className="section-head">
          <h2>{yearSel === "all" ? "All years" : filters.month ? monthTitle(filters.month) : yearSel}</h2>
          {data && (
            <span className="tx-summary muted small">
              <span>
                {data.total.toLocaleString()} {data.total === 1 ? "entry" : "entries"}
              </span>
              <span>
                In <strong className="pos">{money(data.totals.income)}</strong>
              </span>
              <span>
                Out <strong className="neg">{money(data.totals.expense)}</strong>
              </span>
              <span>
                Net <strong>{money(data.totals.net)}</strong>
              </span>
            </span>
          )}
        </div>

        <div className="tx-toolbar">
          <div className="chips" role="group" aria-label="Show">
            {CHIPS.filter((c) => !c.optional || chipOn[c.key] || !data?.counts || data.counts[c.count] > 0).map((c) => (
              <button
                key={c.key}
                className={`chip ${chipOn[c.key] ? "on" : ""}`}
                aria-pressed={chipOn[c.key]}
                onClick={() => pickChip(c.key)}
              >
                {c.label} {data?.counts && <small>{data.counts[c.count].toLocaleString()}</small>}
              </button>
            ))}
          </div>
          <SelectToggle sel={sel} />
        </div>

        <div className="tx-tools">
          <input
            type="search"
            className="tx-search"
            placeholder="Search name, note, ref or amount"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search"
          />
          <select
            value={yearSel}
            onChange={(e) => {
              update({ year: e.target.value, month: "" });
              if (e.target.value !== "all") setWorkingYear(Number(e.target.value));
            }}
            aria-label="Year"
          >
            <option value="all">All years</option>
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => set("sort", e.target.value === "date_desc" ? "" : e.target.value)}
            aria-label="Order"
          >
            {SORTS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <button
            className={`btn small ${moreActive ? "has-count" : ""}`}
            aria-expanded={moreOpen}
            aria-controls="tx-more"
            onClick={() => setMoreOpen((o) => !o)}
          >
            Filters{moreActive > 0 && <span className="count">{moreActive}</span>}
          </button>
          {narrowed && (
            <button className="link" onClick={clear}>
              Clear filters
            </button>
          )}
        </div>

        {moreOpen && (
          <div className="tx-more" id="tx-more">
            <label>
              Month
              <select
                value={filters.month ? filters.month.slice(5) : ""}
                onChange={(e) => set("month", e.target.value && !allYears ? `${yearSel}-${e.target.value}` : "")}
                disabled={allYears}
                title={allYears ? "Pick a year first" : undefined}
              >
                <option value="">All months</option>
                {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map((m) => (
                  <option key={m} value={m}>
                    {new Date(2000, Number(m) - 1).toLocaleString("en-US", { month: "long" })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Category
              <select value={filters.category} onChange={(e) => set("category", e.target.value)}>
                <option value="">All categories</option>
                {overview.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.archived ? " (archived)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tax treatment
              <select value={filters.allocation} onChange={(e) => set("allocation", e.target.value)}>
                <option value="">Direct &amp; indirect</option>
                <option value="direct">Direct</option>
                <option value="indirect">Indirect</option>
                <option value="none">Not set</option>
              </select>
            </label>
            <label>
              Receipt
              <select value={filters.has_attachment} onChange={(e) => set("has_attachment", e.target.value)}>
                <option value="">Any</option>
                <option value="true">Has a receipt</option>
                <option value="false">No receipt</option>
              </select>
            </label>
            <label>
              Amount
              <input
                inputMode="decimal"
                placeholder="69.95, 50-100, >500, ~70"
                title="Amount (sign ignored): 69.95 exact · 70 = $70.00–70.99 · 50-100 range · >500 · <20 · ~70 within 10%"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            {/* filters that only arrive by link have no control of their own; show them so they can be removed */}
            {(filters.vendor || filters.min_amount || filters.max_amount) && (
              <div className="chips tx-link-filters">
                {filters.vendor && (
                  <button className="chip small on" onClick={() => set("vendor", "")} aria-label="Remove vendor filter">
                    Name: {filters.vendor} ✕
                  </button>
                )}
                {filters.min_amount && (
                  <button className="chip small on" onClick={() => set("min_amount", "")} aria-label="Remove minimum">
                    At least {money(Number(filters.min_amount))} ✕
                  </button>
                )}
                {filters.max_amount && (
                  <button className="chip small on" onClick={() => set("max_amount", "")} aria-label="Remove maximum">
                    At most {money(Number(filters.max_amount))} ✕
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <BulkBar sel={sel} ids={data?.items.map((t) => t.id) ?? []} onChanged={() => void reload()} />

        {error && <div className="alert error">{error}</div>}
        <div className={loading ? "loading" : ""}>
          {data && data.items.length === 0 ? (
            <p className="muted">No transactions match.</p>
          ) : (
            groups.map((g) => (
              <div key={g.ym || "all"} className="tx-group">
                {g.ym && (
                  <h3 className="group-title">
                    <Link to={scoped(`/months/${g.ym}`)}>{monthTitle(g.ym)} ›</Link>
                  </h3>
                )}
                <ul className="tx-mini tx-flat">
                  {g.items.map((t) => (
                    <TxRow key={t.id} t={t} ctx={ctx} withCategory />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

        {data && data.total > PAGE && (
          <div className="pager">
            <button
              className="btn"
              disabled={offset === 0}
              onClick={() => setParams((p) => (p.set("offset", String(Math.max(0, offset - PAGE))), p))}
            >
              ← Prev
            </button>
            <span>
              {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total.toLocaleString()}
            </span>
            <button
              className="btn"
              disabled={offset + PAGE >= data.total}
              onClick={() => setParams((p) => (p.set("offset", String(offset + PAGE)), p))}
            >
              Next →
            </button>
          </div>
        )}
      </section>

      {editing && (
        <TxEditModal
          id={editing}
          initial={data?.items.find((t) => t.id === editing)}
          onClose={() => setEditing(null)}
          onChanged={() => void reload()}
        />
      )}
    </div>
  );
}

/** Consecutive entries of the same month, in the order they came. */
function byMonth(items: Transaction[]) {
  const out: { ym: string; items: Transaction[] }[] = [];
  for (const t of items) {
    const ym = t.date.slice(0, 7);
    const last = out.at(-1);
    if (last?.ym === ym) last.items.push(t);
    else out.push({ ym, items: [t] });
  }
  return out;
}
