import { useState } from "react";
import { type MonthDetail } from "../api.ts";
import { money, money0, monthTitle } from "../format.ts";
import { usePendingByEntry, usePersistentState, useSession, useTxSelection } from "../hooks.ts";
import { Amount } from "../lib.tsx";
import {
  applyView,
  isNarrowed,
  showCount,
  type MonthView,
  type Tx,
  type TxLayout,
  type TxShow,
} from "../month-view.ts";
import { BulkBar, SelectToggle, TxRow, type RowCtx } from "./TxRows.tsx";

const CHIPS: { key: TxShow; label: string; optional?: boolean }[] = [
  { key: "all", label: "All" },
  { key: "income", label: "Income" },
  { key: "expense", label: "Expenses" },
  { key: "review", label: "Flagged", optional: true },
  { key: "receipt", label: "Needs receipt", optional: true },
];

export default function MonthTransactions({
  detail,
  items,
  ym,
  view,
  setView,
  showProperty,
  onOpen,
  onChanged,
}: {
  detail: MonthDetail;
  items: Tx[];
  ym: string;
  view: MonthView;
  setView: (patch: Partial<MonthView>) => void;
  showProperty: boolean;
  onOpen: (id: number) => void;
  onChanged: () => void;
}) {
  const { canWrite } = useSession();
  // how to lay the list out is a habit worth keeping on this device; the URL can still say otherwise
  const [saved, setSaved] = usePersistentState<TxLayout>("month-tx-view", "list");
  const layout = view.layout ?? saved;
  const [text, setText] = useState(view.q);
  const rows = applyView(items, view);
  const net = rows.reduce((sum, t) => sum + t.amount, 0);
  const narrowed = isNarrowed(view);
  const categories = [...new Map(items.map((t) => [t.category_id, t.category])).entries()].sort((a, b) =>
    a[1].localeCompare(b[1]),
  );
  const pending = usePendingByEntry();
  const sel = useTxSelection();
  const ctx: RowCtx = { canWrite, showProperty, onOpen, onChanged, pending, select: sel.ctx };
  const clear = () => {
    setText("");
    setView({ show: "all", q: "", cat: null });
  };

  return (
    <section className="card">
      <div className="section-head">
        <h2>Transactions</h2>
        {rows.length > 0 && (
          <span className="muted small">
            {rows.length} {rows.length === 1 ? "entry" : "entries"} · <Amount value={net} />
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="muted">Nothing recorded for {monthTitle(ym)}.</p>
      ) : (
        <>
          <div className="tx-toolbar">
            <div className="chips" role="group" aria-label="Show">
              {CHIPS.filter((c) => !c.optional || showCount(items, c.key) > 0 || view.show === c.key).map((c) => (
                <button
                  key={c.key}
                  className={`chip ${view.show === c.key ? "on" : ""}`}
                  aria-pressed={view.show === c.key}
                  onClick={() => setView({ show: c.key })}
                >
                  {c.label} <small>{showCount(items, c.key)}</small>
                </button>
              ))}
            </div>
            <div className="tx-toolbar-end">
              <div className="segmented small" role="group" aria-label="Layout">
                {(["list", "category"] as const).map((l) => (
                  <button
                    key={l}
                    className={layout === l ? "on" : ""}
                    aria-pressed={layout === l}
                    onClick={() => {
                      setSaved(l);
                      setView({ layout: l });
                    }}
                  >
                    {l === "list" ? "List" : "By category"}
                  </button>
                ))}
              </div>
              <SelectToggle sel={sel} />
            </div>
          </div>
          <div className="tx-tools">
            <input
              type="search"
              className="tx-search"
              placeholder="Search name, note or amount"
              aria-label="Search this month"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setView({ q: e.target.value });
              }}
            />
            {categories.length > 1 && (
              <select
                aria-label="Category"
                value={view.cat ?? ""}
                onChange={(e) => setView({ cat: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">All categories</option>
                {categories.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label="Order"
              value={view.sort}
              onChange={(e) => setView({ sort: e.target.value === "desc" ? "desc" : "asc" })}
            >
              <option value="asc">Oldest first</option>
              <option value="desc">Newest first</option>
            </select>
            {narrowed && (
              <button className="link" onClick={clear}>
                Clear filters
              </button>
            )}
          </div>
          <BulkBar sel={sel} ids={rows.map((t) => t.id)} onChanged={onChanged} />
          {rows.length === 0 ? (
            <p className="muted">Nothing matches.</p>
          ) : layout === "list" ? (
            <ul className="tx-mini tx-flat">
              {rows.map((t) => (
                <TxRow key={t.id} t={t} ctx={ctx} withCategory />
              ))}
            </ul>
          ) : (
            <CategoryGroups detail={detail} rows={rows} whole={!narrowed} ctx={ctx} />
          )}
        </>
      )}
    </section>
  );
}

function CategoryGroups({
  detail,
  rows,
  whole,
  ctx,
}: {
  detail: MonthDetail;
  rows: Tx[];
  /** the rows are the whole month, so the month's own 12-month averages apply */
  whole: boolean;
  ctx: RowCtx;
}) {
  const byCat = new Map(detail.by_category.map((c) => [c.category_id, c]));
  const order = detail.by_category.map((c) => c.category_id);
  return (
    <div className="cat-groups">
      {(["income", "expense"] as const).map((kind) => {
        const kindRows = rows.filter((t) => t.kind === kind);
        if (!kindRows.length) return null;
        // the month's own category order first, then anything it doesn't know
        const ids = [...new Set(kindRows.map((t) => t.category_id))].sort(
          (a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9),
        );
        const total = kindRows.reduce((sum, t) => sum + t.amount, 0);
        return (
          <div key={kind}>
            <h3 className="group-title">
              {kind === "income" ? "Income" : "Expenses"}
              <span>{money(total)}</span>
            </h3>
            {ids.map((id) => {
              const g = byCat.get(id);
              const catRows = kindRows.filter((t) => t.category_id === id);
              const amount = catRows.reduce((sum, t) => sum + t.amount, 0);
              const vsAvg = g ? Math.abs(amount) - Math.abs(g.avg_12) : 0;
              return (
                <details key={id} className="cat-group" open>
                  <summary>
                    <span className="cat-name">
                      {catRows[0]!.category} <small className="muted">({catRows.length})</small>
                    </span>
                    <span className="cat-compare muted small">
                      {whole && g && (
                        <>
                          avg {money0(Math.abs(g.avg_12))}
                          {Math.abs(g.avg_12) > 0 && Math.abs(vsAvg) >= 1 && (
                            <span className={`delta ${vsAvg > 0 === (kind === "income") ? "good" : "bad"}`}>
                              {" "}
                              {vsAvg > 0 ? "▲" : "▼"} {money0(Math.abs(vsAvg))}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                    <Amount value={amount} />
                  </summary>
                  <ul className="tx-mini">
                    {catRows.map((t) => (
                      <TxRow key={t.id} t={t} ctx={ctx} />
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
