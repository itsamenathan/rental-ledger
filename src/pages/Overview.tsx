import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { CategoryMonths, Recurring, Totals, TxList } from "../api.ts";
import {
  CumulativeChart,
  HBars,
  MonthlyChart,
  StackedMonthly,
  type MonthPoint,
  type StackSeries,
} from "../components/Charts.tsx";
import type { TodoSummary } from "./Todo.tsx";
import { fmtDate, money, money0, monthLabel, percent, thisMonth, THIS_YEAR } from "../format.ts";
import { useApi, usePersistentState, useSession, useProperty } from "../hooks.ts";
import { AllocationBadge, Amount, YearSelect } from "../lib.tsx";

interface Summary {
  totals: Totals;
  comparison: { through: string; current: Totals; previous: Totals };
  occupancy: {
    months_recorded: number;
    nights_booked: number;
    owner_nights: number;
    occupancy_rate: number | null;
    avg_stay: number | null;
    revenue_per_booked_night: number | null;
  };
  monthly: (MonthPoint & { nights_booked: number | null })[];
  by_category: { category_id: number; category: string; kind: string; amount: number; count: number }[];
  top_vendors: { vendor: string; amount: number; count: number }[];
  needs_review: number;
  /** all-properties view only */
  by_property:
    | (Totals & {
        property_id: number;
        property: string;
        archived: boolean;
        nights_booked: number;
        occupancy_rate: number | null;
      })[]
    | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Delta({ now, prev, goodWhenUp = true }: { now: number; prev: number; goodWhenUp?: boolean }) {
  if (!prev) return null;
  const d = (now - prev) / Math.abs(prev);
  const up = d >= 0;
  const good = up === goodWhenUp;
  return (
    <span className={`delta ${good ? "good" : "bad"}`}>
      {up ? "▲" : "▼"} {Math.abs(d * 100).toFixed(0)}% vs last year
    </span>
  );
}

export default function Overview() {
  const scope = useProperty();
  const { path: scoped, qs: pq } = scope;
  const [params, setParams] = useSearchParams();
  const [year, setYear] = usePersistentState("dash-year", THIS_YEAR);
  // /?year=2025 (e.g. from a month page) selects that year
  useEffect(() => {
    const y = Number(params.get("year"));
    if (y) {
      setYear(y);
      setParams({}, { replace: true });
    }
  }, [params, setParams, setYear]);
  const { data: s, error } = useApi<Summary>(`reports/summary?year=${year}&${pq}`);
  const rec = useApi<Recurring>(`recurring?${pq}`);
  const todo = useApi<TodoSummary>(`todo?${pq}`);
  const recent = useApi<TxList>(`transactions?limit=8&sort=updated_desc&${pq}`);
  const prev = useApi<Summary>(`reports/summary?year=${year - 1}&${pq}`);
  const cats = useApi<CategoryMonths>(`reports/categories?year=${year}&${pq}`);
  const years = useApi<(Totals & { year: number; nights_booked: number })[]>(`reports/years?${pq}`);
  const navigate = useNavigate();
  const { canWrite } = useSession();
  const openMonth = (m: string) => void navigate(scoped(`/months/${m}`));

  const missingByMonth = new Map<string, number>();
  for (const a of rec.data?.alerts ?? [])
    if (a.level === "warning") missingByMonth.set(a.month, (missingByMonth.get(a.month) ?? 0) + 1);
  const current = thisMonth();
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

  // Running profit: cumulative net, this year (only through the current month) vs last year.
  const cumulative = (pts: MonthPoint[] | undefined, stopAt?: string) => {
    let run = 0;
    return months.map((mo, i) => {
      if (!pts || (stopAt && mo > stopAt)) return null;
      run += pts[i]?.net ?? 0;
      return Math.round(run);
    });
  };
  const thisRun = cumulative(s?.monthly, current);
  const lastRun = cumulative(prev.data?.monthly);
  const atIdx = thisRun.reduce<number>((k, v, i) => (v != null ? i : k), -1);
  const hasLastYear = !!prev.data && prev.data.totals.count > 0;

  // Where the money goes: top 3 expense categories by year total, the rest folded into "Other".
  const stack: StackSeries[] = (() => {
    const byCat = new Map<string, number[]>();
    for (const r of cats.data?.rows ?? []) {
      if (r.kind !== "expense") continue;
      const v = byCat.get(r.category) ?? Array(12).fill(0);
      r.months.forEach((x, i) => (v[i] += x));
      byCat.set(r.category, v);
    }
    const sorted = [...byCat.entries()].sort(
      (a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0),
    );
    const top = sorted.slice(0, 3).map(([label, values]) => ({ label, values }));
    const rest = sorted.slice(3);
    if (rest.length)
      top.push({
        label: rest.length === 1 ? rest[0]![0] : "Everything else",
        values: months.map((_, i) => rest.reduce((a, [, v]) => a + v[i]!, 0)),
      });
    return top;
  })();

  return (
    <div className="page">
      <header className="page-head">
        <h1>{scope.key === "all" ? "All properties" : "Overview"}</h1>
        <div className="head-actions">
          <YearSelect value={year} onChange={setYear} />
          {canWrite && (
            <Link className="btn primary" to={scoped("/add")}>
              + Add entry
            </Link>
          )}
        </div>
      </header>
      {error && <div className="alert error">{error}</div>}

      {todo.data && todo.data.total > 0 && (
        <Link to={scoped("/todo")} className="alert warn link-alert todo-strip">
          <strong>To do:</strong>{" "}
          {[
            todo.data.flagged && plural(todo.data.flagged, "flagged entry", "flagged entries"),
            todo.data.unallocated &&
              plural(todo.data.unallocated, "expense needs direct/indirect", "expenses need direct/indirect"),
            todo.data.recurring && plural(todo.data.recurring, "recurring bill to check", "recurring bills to check"),
          ]
            .filter(Boolean)
            .join(" · ")}{" "}
          →
        </Link>
      )}

      {s && (
        <>
          <div className="tiles">
            <div className="tile">
              <span className="tile-label">Income</span>
              <span className="tile-value">{money0(s.totals.income)}</span>
              <Delta now={s.comparison.current.income} prev={s.comparison.previous.income} />
            </div>
            <div className="tile">
              <span className="tile-label">Expenses</span>
              <span className="tile-value">{money0(s.totals.expense)}</span>
              <Delta now={s.comparison.current.expense} prev={s.comparison.previous.expense} goodWhenUp={false} />
            </div>
            <div className="tile">
              <span className="tile-label">Net</span>
              <span className={`tile-value ${s.totals.net < 0 ? "neg" : ""}`}>{money0(s.totals.net)}</span>
              <Delta now={s.comparison.current.net} prev={s.comparison.previous.net} />
            </div>
            <div className="tile">
              <span className="tile-label">Occupancy</span>
              <span className="tile-value">{percent(s.occupancy.occupancy_rate, 0)}</span>
              <span className="tile-sub">
                {s.occupancy.nights_booked} nights booked
                {s.occupancy.revenue_per_booked_night ? ` · ${money0(s.occupancy.revenue_per_booked_night)}/night` : ""}
              </span>
            </div>
          </div>

          {s.by_property && (
            <section className="card table-card">
              <div className="section-head card-pad">
                <h2>By property, {year}</h2>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th className="num">Income</th>
                    <th className="num">Expenses</th>
                    <th className="num">Net</th>
                    <th className="num hide-sm">Occupancy</th>
                  </tr>
                </thead>
                <tbody>
                  {s.by_property.map((p) => (
                    <tr key={p.property_id} className={p.archived ? "excluded" : ""}>
                      <td>
                        <Link to={`/p/${p.property_id}`}>{p.property}</Link>
                      </td>
                      <td className="num">{money0(p.income)}</td>
                      <td className="num">{money0(p.expense)}</td>
                      <td className={`num ${p.net < 0 ? "neg" : ""}`}>{money0(p.net)}</td>
                      <td className="num hide-sm">{percent(p.occupancy_rate, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="card">
            <h2>Month by month, {year}</h2>
            <MonthlyChart data={s.monthly} onPick={openMonth} />
          </section>

          <section className="card table-card">
            <table className="data-table month-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="num">Income</th>
                  <th className="num">Expenses</th>
                  <th className="num">Net</th>
                  <th className="num hide-sm">Nights</th>
                  <th className="hide-sm" />
                </tr>
              </thead>
              <tbody>
                {s.monthly
                  .filter((m) => m.month <= current || m.income || m.expense)
                  .map((m) => (
                    <tr
                      key={m.month}
                      onClick={() => openMonth(m.month)}
                      className={m.month === current ? "current" : ""}
                    >
                      <td>
                        <Link to={scoped(`/months/${m.month}`)} onClick={(e) => e.stopPropagation()}>
                          {monthLabel(m.month, "long")}
                        </Link>
                        {m.month === current && <small className="muted"> · so far</small>}
                      </td>
                      <td className="num pos">{money(m.income)}</td>
                      <td className="num neg">{money(m.expense)}</td>
                      <td className={`num strong ${m.net < 0 ? "neg" : ""}`}>{money(m.net)}</td>
                      <td className="num hide-sm muted">{m.nights_booked ?? "—"}</td>
                      <td className="hide-sm">
                        {missingByMonth.get(m.month) ? (
                          <span className="badge warn">⚠ {missingByMonth.get(m.month)} to check</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{money(s.totals.income)}</td>
                  <td className="num">{money(s.totals.expense)}</td>
                  <td className="num">{money(s.totals.net)}</td>
                  <td className="num hide-sm">{s.occupancy.nights_booked || "—"}</td>
                  <td className="hide-sm" />
                </tr>
              </tfoot>
            </table>
          </section>

          <div className="grid-2">
            <section className="card">
              <h2>Running profit</h2>
              <p className="muted small">
                {atIdx >= 0
                  ? `${money0(thisRun[atIdx])} through ${monthLabel(months[atIdx]!, "long")}`
                  : "No entries yet this year"}
                {hasLastYear && atIdx >= 0 && ` · ${money0(lastRun[atIdx])} at the same point in ${year - 1}`}
              </p>
              <CumulativeChart
                months={months}
                onPick={openMonth}
                series={[
                  { label: String(year), values: thisRun, role: "current" },
                  ...(hasLastYear ? [{ label: String(year - 1), values: lastRun, role: "compare" as const }] : []),
                ]}
              />
            </section>
            <section className="card">
              <h2>Where the money goes</h2>
              <p className="muted small">Monthly expenses, biggest categories first.</p>
              {stack.length ? (
                <StackedMonthly series={stack} months={months} onPick={openMonth} />
              ) : (
                <p className="muted">No expenses in {year}.</p>
              )}
            </section>
          </div>

          <div className="grid-2">
            <section className="card">
              <div className="section-head">
                <h2>Expenses by category</h2>
                <Link to={scoped(`/categories?year=${year}`)} className="link">
                  By month →
                </Link>
              </div>
              <p className="muted small">
                Direct {money0(s.totals.direct)} · Indirect {money0(s.totals.indirect)}
                {s.totals.unallocated ? ` · Not set ${money0(s.totals.unallocated)}` : ""}
              </p>
              <HBars
                rows={s.by_category
                  .filter((c) => c.kind === "expense")
                  .map((c) => ({
                    key: c.category_id,
                    label: c.category,
                    value: c.amount,
                    sub: `${c.count} transactions`,
                  }))}
                onPick={(id) => void navigate(scoped(`/transactions?year=${year}&category=${id}`))}
              />
            </section>
            <section className="card">
              <h2>Who you pay</h2>
              {s.top_vendors.length ? (
                <HBars
                  rows={s.top_vendors.map((v) => ({
                    key: v.vendor,
                    label: v.vendor,
                    value: v.amount,
                    sub: `${v.count} transactions`,
                  }))}
                  onPick={(v) =>
                    void navigate(scoped(`/transactions?year=${year}&kind=expense&q=${encodeURIComponent(String(v))}`))
                  }
                />
              ) : (
                <p className="muted">Add vendors to expenses to see who you pay most.</p>
              )}
            </section>
          </div>
        </>
      )}

      {years.data && years.data.filter((y) => y.count > 0).length > 1 && (
        <section className="card table-card">
          <div className="section-head card-pad">
            <h2>Year by year</h2>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Year</th>
                <th className="num">Income</th>
                <th className="num">Expenses</th>
                <th className="num">Net</th>
                <th className="num hide-sm">Direct</th>
                <th className="num hide-sm">Indirect</th>
                <th className="num hide-sm">Nights</th>
              </tr>
            </thead>
            <tbody>
              {years.data
                .filter((y) => y.count > 0)
                .map((y) => (
                  <tr key={y.year} className={y.year === year ? "current" : ""}>
                    <td>
                      <button className="link" onClick={() => setYear(y.year)}>
                        {y.year}
                      </button>
                      {y.year === THIS_YEAR && <small className="muted"> · so far</small>}
                    </td>
                    <td className="num pos">{money0(y.income)}</td>
                    <td className="num neg">{money0(y.expense)}</td>
                    <td className={`num strong ${y.net < 0 ? "neg" : ""}`}>{money0(y.net)}</td>
                    <td className="num hide-sm">{money0(y.direct)}</td>
                    <td className="num hide-sm">{money0(y.indirect)}</td>
                    <td className="num hide-sm muted">{y.nights_booked || "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <div className="section-head">
          <h2>Recently changed</h2>
          <Link to={scoped("/transactions?year=all&sort=updated_desc")} className="link">
            All transactions →
          </Link>
        </div>
        <ul className="tx-mini">
          {recent.data?.items.map((t) => (
            <li key={t.id}>
              <Link to={scoped(`/transactions?year=all&q=${t.id}`)} className="row-btn">
                <span>{fmtDate(t.date)}</span>
                <span>
                  {t.category}
                  {t.vendor && <small> · {t.vendor}</small>}
                  {t.source !== "web" && <small className="muted"> · via {t.source}</small>}
                </span>
                <AllocationBadge value={t.allocation} />
                <Amount value={t.amount} />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
