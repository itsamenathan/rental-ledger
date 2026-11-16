import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, qs, type TxList } from "../api.ts";
import TxEditModal from "../components/TxEditModal.tsx";
import { fmtDate, money } from "../format.ts";
import { useApi, useSession, useToast } from "../hooks.ts";
import { AllocationBadge, Amount } from "../lib.tsx";

const PAGE = 100;
const FILTER_KEYS = [
  "year",
  "month",
  "category",
  "kind",
  "allocation",
  "q",
  "amount",
  "needs_review",
  "has_attachment",
  "needs_receipt",
  "vendor",
  "property_id",
] as const;

export default function Transactions() {
  const { overview, canWrite } = useSession();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [amount, setAmount] = useState(params.get("amount") ?? "");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const toast = useToast();

  // Default to the current year. ?year=all shows every year; a month filter implies its own year.
  const yearParam = params.get("year");
  const allYears = yearParam === "all";
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ""]));
  filters.year = allYears ? "" : yearParam || (filters.month ? "" : String(new Date().getFullYear()));
  const offset = Number(params.get("offset") ?? 0);
  const query = qs({ ...filters, limit: PAGE, offset, sort: params.get("sort") ?? "date_desc" });
  const { data, error, loading, reload } = useApi<TxList>(`transactions${query}`);

  useEffect(() => setSelected(new Set()), [query]);
  // debounce search box into the URL
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

  function set(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("offset");
    setParams(next, { replace: true });
  }

  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOnPage = data?.items.length ? data.items.every((t) => selected.has(t.id)) : false;

  const bulk = async (patch: Record<string, unknown>, label: string) => {
    const ids = [...selected];
    try {
      await api("transactions/bulk-update", { method: "POST", json: { ids, patch } });
      toast({ text: `${label}: ${ids.length} updated`, kind: "ok" });
      void reload();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  const bulkDelete = async () => {
    const ids = [...selected];
    if (!confirm(`Delete ${ids.length} transaction(s)?`)) return;
    await api("transactions/bulk-delete", { method: "POST", json: { ids } });
    toast({ text: `${ids.length} deleted`, kind: "ok" });
    void reload();
  };

  const yearSel = allYears ? "all" : filters.year || (filters.month ?? "").slice(0, 4);
  const active = FILTER_KEYS.filter((k) => params.get(k)).length;
  const years = [...new Set([new Date().getFullYear(), ...overview.years])].sort((a, b) => b - a);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Transactions</h1>
        <div className="head-actions">
          <a className="btn" href={`/api/export/transactions.csv${qs(filters)}`}>
            Export CSV
          </a>
          {canWrite && (
            <Link className="btn" to="/import">
              Import CSV
            </Link>
          )}
          {canWrite && (
            <Link className="btn primary" to="/add">
              + Add
            </Link>
          )}
        </div>
      </header>

      <div className="filters card">
        <input
          type="search"
          placeholder="Search vendor, description, ref, $amount…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search"
        />
        <input
          className="amount-search"
          inputMode="decimal"
          placeholder="Amount: 69.95, 50-100, >500, ~70"
          title="Amount (sign ignored): 69.95 exact · 70 = $70.00–70.99 · 50-100 range · >500 · <20 · ~70 within 10%"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Amount"
        />
        <select
          value={yearSel}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            next.set("year", e.target.value);
            next.delete("month");
            next.delete("offset");
            setParams(next, { replace: true });
          }}
          aria-label="Year"
        >
          <option value="all">All years</option>
          {years.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
        <select
          value={filters.month ? filters.month.slice(5) : ""}
          onChange={(e) => set("month", e.target.value && !allYears ? `${yearSel}-${e.target.value}` : "")}
          disabled={allYears}
          aria-label="Month"
        >
          <option value="">All months</option>
          {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map((m) => (
            <option key={m} value={m}>
              {new Date(2000, Number(m) - 1).toLocaleString("en-US", { month: "long" })}
            </option>
          ))}
        </select>
        <select value={filters.category} onChange={(e) => set("category", e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {overview.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.archived ? " (archived)" : ""}
            </option>
          ))}
        </select>
        <select value={filters.kind} onChange={(e) => set("kind", e.target.value)} aria-label="Type">
          <option value="">Income &amp; expenses</option>
          <option value="income">Income</option>
          <option value="expense">Expenses</option>
        </select>
        <select
          value={filters.allocation}
          onChange={(e) => set("allocation", e.target.value)}
          aria-label="Tax treatment"
        >
          <option value="">Direct &amp; indirect</option>
          <option value="direct">Direct</option>
          <option value="indirect">Indirect</option>
          <option value="none">Not set</option>
        </select>
        <select
          value={filters.needs_receipt === "true" ? "needs" : filters.has_attachment}
          onChange={(e) => {
            // "Needs a receipt" uses the category/vendor receipt rules (same list as To do, Files and the tax check)
            const v = e.target.value;
            const next = new URLSearchParams(params);
            next.delete("has_attachment");
            next.delete("needs_receipt");
            if (v === "needs") next.set("needs_receipt", "true");
            else if (v) next.set("has_attachment", v);
            next.delete("offset");
            setParams(next, { replace: true });
          }}
          aria-label="Receipts"
        >
          <option value="">Any receipt status</option>
          <option value="true">Has receipt</option>
          <option value="false">No receipt</option>
          <option value="needs">Needs a receipt</option>
        </select>
        {overview.properties.length > 1 && (
          <select
            value={filters.property_id}
            onChange={(e) => set("property_id", e.target.value)}
            aria-label="Property"
          >
            <option value="">All properties</option>
            {overview.properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={filters.needs_review === "true"}
            onChange={(e) => set("needs_review", e.target.checked ? "true" : "")}
          />
          Needs review
        </label>
        {active > 0 && (
          <button
            className="link"
            onClick={() => {
              setSearch("");
              setAmount("");
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {data && (
        <div className="totals-bar">
          <span>
            <strong>{data.total.toLocaleString()}</strong> transactions
          </span>
          <span>
            Income <strong className="pos">{money(data.totals.income)}</strong>
          </span>
          <span>
            Expenses <strong className="neg">{money(data.totals.expense)}</strong>
          </span>
          <span>
            Net <strong>{money(data.totals.net)}</strong>
          </span>
        </div>
      )}

      {selected.size > 0 && canWrite && (
        <div className="bulk-bar card">
          <strong>{selected.size} selected</strong>
          <select
            defaultValue=""
            onChange={(e) =>
              e.target.value &&
              void bulk({ category_id: Number(e.target.value) }, "Category changed").then(() => (e.target.value = ""))
            }
            aria-label="Set category"
          >
            <option value="">Set category…</option>
            {overview.categories
              .filter((c) => !c.archived)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <button className="btn small" onClick={() => void bulk({ allocation: "direct" }, "Marked direct")}>
            Direct
          </button>
          <button className="btn small" onClick={() => void bulk({ allocation: "indirect" }, "Marked indirect")}>
            Indirect
          </button>
          <button className="btn small" onClick={() => void bulk({ needs_review: false }, "Reviewed")}>
            Mark reviewed
          </button>
          <button className="btn small danger-outline" onClick={() => void bulkDelete()}>
            Delete
          </button>
          <button className="link" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}
      <div className={`card table-card ${loading ? "loading" : ""}`}>
        <table className="tx-table">
          <thead>
            <tr>
              {canWrite && (
                <th className="sel">
                  <input
                    type="checkbox"
                    checked={allOnPage}
                    aria-label="Select all on page"
                    onChange={() => setSelected(allOnPage ? new Set() : new Set(data?.items.map((t) => t.id)))}
                  />
                </th>
              )}
              <th>
                <SortHeader label="Date" asc="date_asc" desc="date_desc" params={params} set={set} />
              </th>
              <th>Category</th>
              <th>Vendor / description</th>
              <th>Tax</th>
              <th className="num">
                <SortHeader label="Amount" asc="amount_asc" desc="amount_desc" params={params} set={set} />
              </th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((t) => (
              <tr key={t.id} className={t.needs_review ? "flagged" : ""} onClick={() => setEditing(t.id)}>
                {canWrite && (
                  <td className="sel" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggle(t.id)}
                      aria-label={`Select #${t.id}`}
                    />
                  </td>
                )}
                <td className="date">{fmtDate(t.date)}</td>
                <td>
                  {t.category}
                  {t.subcategory && <small className="muted"> · {t.subcategory}</small>}
                </td>
                <td className="desc">
                  {t.vendor && <strong>{t.vendor} </strong>}
                  <span className="muted">{t.description || t.reference}</span>
                  {t.attachment_count > 0 && (
                    <span className="clip" title={`${t.attachment_count} receipt(s)`}>
                      📎
                    </span>
                  )}
                  {t.needs_review && (
                    <span className="badge warn" title={t.review_note}>
                      ⚑ Review
                    </span>
                  )}
                </td>
                <td>
                  <AllocationBadge value={t.allocation} />
                </td>
                <td className="num">
                  <Amount value={t.amount} />
                </td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No transactions match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > PAGE && (
        <div className="pager">
          <button
            className="btn"
            disabled={offset === 0}
            onClick={() => setParams((p) => (p.set("offset", String(Math.max(0, offset - PAGE))), p))}
          >
            ← Newer
          </button>
          <span>
            {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}
          </span>
          <button
            className="btn"
            disabled={offset + PAGE >= data.total}
            onClick={() => setParams((p) => (p.set("offset", String(offset + PAGE)), p))}
          >
            Older →
          </button>
        </div>
      )}

      {editing && <TxEditModal id={editing} onClose={() => setEditing(null)} onChanged={() => void reload()} />}
    </div>
  );
}

function SortHeader({
  label,
  asc,
  desc,
  params,
  set,
}: {
  label: string;
  asc: string;
  desc: string;
  params: URLSearchParams;
  set: (k: string, v: string) => void;
}) {
  const sort = params.get("sort") ?? "date_desc";
  const dir = sort === asc ? "↑" : sort === desc ? "↓" : "";
  return (
    <button className="th-btn" onClick={() => set("sort", sort === desc ? asc : desc)}>
      {label} {dir}
    </button>
  );
}
