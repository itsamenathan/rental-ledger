import { Fragment, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { qs, type CategoryMonths } from "../api.ts";
import { money, money0, monthLabel, THIS_YEAR } from "../format.ts";
import { useApi, usePersistentState, useProperty } from "../hooks.ts";
import { YearSelect } from "../lib.tsx";

type Row = CategoryMonths["rows"][number];
interface Group {
  category_id: number;
  category: string;
  months: number[];
  total: number;
  prev_total: number;
  subs: Row[];
}

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

function group(rows: Row[]): Group[] {
  const out = new Map<number, Group>();
  for (const r of rows) {
    if (!out.has(r.category_id))
      out.set(r.category_id, {
        category_id: r.category_id,
        category: r.category,
        months: Array(12).fill(0),
        total: 0,
        prev_total: 0,
        subs: [],
      });
    const g = out.get(r.category_id)!;
    r.months.forEach((v, i) => (g.months[i]! += v));
    g.total += r.total;
    g.prev_total += r.prev_total;
    g.subs.push(r);
  }
  return [...out.values()].sort((a, b) => b.total - a.total);
}

export default function Categories() {
  const { path: scoped, qs: pq } = useProperty();
  const [params, setParams] = useSearchParams();
  const [savedYear, setYear] = usePersistentState("dash-year", THIS_YEAR);
  const year = Number(params.get("year")) || savedYear;
  const kind = params.get("kind") === "income" ? "income" : "expense";
  const { data, error, loading } = useApi<CategoryMonths>(`reports/categories?year=${year}&${pq}`);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };
  const groups = group((data?.rows ?? []).filter((r) => r.kind === kind));
  const colTotals = MONTHS.map((_, i) => groups.reduce((a, g) => a + g.months[i]!, 0));
  const grand = groups.reduce((a, g) => a + g.total, 0);
  const prevGrand = groups.reduce((a, g) => a + g.prev_total, 0);
  const max = Math.max(1, ...groups.flatMap((g) => g.months));
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const txLink = (categoryId: number, month?: string, sub?: string) =>
    scoped(
      `/transactions${qs({ year: month ? undefined : year, month: month ? `${year}-${month}` : undefined, category: categoryId, q: sub })}`,
    );

  const cell = (v: number, to: string) => (
    <td className="num pivot-cell" style={{ ["--heat" as string]: Math.min(1, v / max).toFixed(3) }}>
      {v ? (
        <Link to={to} title={money(v)}>
          {money0(v)}
        </Link>
      ) : (
        <span className="muted">·</span>
      )}
    </td>
  );

  return (
    <div className="page wide">
      <header className="page-head">
        <h1>Categories</h1>
        <div className="head-actions">
          <div className="segmented" role="radiogroup" aria-label="Type">
            {(["expense", "income"] as const).map((k) => (
              <button
                key={k}
                role="radio"
                aria-checked={kind === k}
                className={kind === k ? "on" : ""}
                onClick={() => set("kind", k)}
              >
                {k === "expense" ? "Expenses" : "Income"}
              </button>
            ))}
          </div>
          <YearSelect
            value={year}
            onChange={(y) => {
              setYear(y);
              set("year", String(y));
            }}
          />
        </div>
      </header>
      <p className="muted small">
        Each {kind === "expense" ? "expense" : "income"} category by month for {year}. Click an amount to see the
        transactions; click a category with ▸ to split it by subcategory.
      </p>
      {error && <div className="alert error">{error}</div>}
      <div className={`card table-card pivot-wrap ${loading ? "loading" : ""}`}>
        <table className="data-table pivot">
          <thead>
            <tr>
              <th className="sticky-col">Category</th>
              {MONTHS.map((m) => (
                <th key={m} className="num">
                  <Link to={scoped(`/months/${year}-${m}`)}>{monthLabel(`${year}-${m}`)}</Link>
                </th>
              ))}
              <th className="num">Total</th>
              <th className="num">{year - 1}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const splittable = g.subs.length > 1 || (g.subs[0]?.subcategory ?? "") !== "";
              const isOpen = open.has(g.category_id);
              const change = g.prev_total ? (g.total - g.prev_total) / g.prev_total : null;
              return (
                <Fragment key={g.category_id}>
                  <tr className="pivot-group">
                    <th scope="row" className="sticky-col">
                      {splittable ? (
                        <button className="th-btn" onClick={() => toggle(g.category_id)} aria-expanded={isOpen}>
                          {isOpen ? "▾" : "▸"} {g.category}
                        </button>
                      ) : (
                        <span className="no-caret">{g.category}</span>
                      )}
                    </th>
                    {g.months.map((v, i) => (
                      <Fragment key={i}>{cell(v, txLink(g.category_id, MONTHS[i]))}</Fragment>
                    ))}
                    <td className="num strong">
                      <Link to={txLink(g.category_id)}>{money0(g.total)}</Link>
                    </td>
                    <td
                      className="num muted"
                      title={change == null ? "" : `${(change * 100).toFixed(0)}% vs ${year - 1}`}
                    >
                      {g.prev_total ? money0(g.prev_total) : "—"}
                    </td>
                  </tr>
                  {isOpen &&
                    g.subs
                      .sort((a, b) => b.total - a.total)
                      .map((s) => (
                        <tr key={s.subcategory} className="pivot-sub">
                          <th scope="row" className="sticky-col">
                            {s.subcategory || <span className="muted">(none)</span>}
                          </th>
                          {s.months.map((v, i) => (
                            <Fragment key={i}>
                              {cell(v, txLink(g.category_id, MONTHS[i], s.subcategory || undefined))}
                            </Fragment>
                          ))}
                          <td className="num">{money0(s.total)}</td>
                          <td className="num muted">{s.prev_total ? money0(s.prev_total) : "—"}</td>
                        </tr>
                      ))}
                </Fragment>
              );
            })}
            {data && groups.length === 0 && (
              <tr>
                <td colSpan={15} className="empty">
                  No {kind === "expense" ? "expenses" : "income"} in {year}.
                </td>
              </tr>
            )}
          </tbody>
          {groups.length > 0 && (
            <tfoot>
              <tr>
                <th scope="row" className="sticky-col">
                  Total
                </th>
                {colTotals.map((v, i) => (
                  <td key={i} className="num">
                    {v ? money0(v) : ""}
                  </td>
                ))}
                <td className="num">{money0(grand)}</td>
                <td className="num muted">{prevGrand ? money0(prevGrand) : "—"}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
