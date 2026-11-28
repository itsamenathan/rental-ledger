import { useEffect, useState } from "react";
import { apiUrl } from "../portfolio.ts";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import {
  addLinkFor,
  dismissRecurring,
  qs,
  type ChecklistItem,
  type MonthDetail,
  type Recurring,
  type TxList,
} from "../api.ts";
import AttentionList from "../components/AttentionList.tsx";
import { MonthNav } from "../components/MonthPicker.tsx";
import MonthTransactions from "../components/MonthTransactions.tsx";
import RecordBills from "../components/RecordBills.tsx";
import TxEditModal from "../components/TxEditModal.tsx";
import { fmtDate, money, money0, monthShort, shiftMonth, thisMonth } from "../format.ts";
import { useApi, useSession, useToast, useScopedPath, useProperty } from "../hooks.ts";
import { Amount } from "../lib.tsx";
import { exportFilters, isNarrowed, readView, viewSearch, withView, type MonthView } from "../month-view.ts";

export default function MonthPage() {
  const scoped = useScopedPath();
  const { ym = "" } = useParams();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return <Navigate to={scoped("/")} />;
  return <Month key={ym} ym={ym} />;
}

function Compare({ label, now, then, goodWhenUp }: { label: string; now: number; then: number; goodWhenUp: boolean }) {
  if (!then) return <span className="tile-sub">{label}: —</span>;
  const d = now - then;
  const good = d >= 0 === goodWhenUp;
  return (
    <span className="tile-sub">
      {label}: {money0(then)}{" "}
      {Math.abs(d) >= 1 && (
        <span className={`delta ${good ? "good" : "bad"}`}>
          {d > 0 ? "▲" : "▼"} {money0(Math.abs(d))}
        </span>
      )}
    </span>
  );
}

/** Arrow keys step through months, unless the person is typing or a dialog is open. */
function useMonthKeys(enabled: boolean, go: (delta: number) => void) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable], [role=dialog], details")) return;
      go(e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, go]);
}

function Month({ ym }: { ym: string }) {
  const { path: scoped, qs: pq, key } = useProperty();
  const { canWrite } = useSession();
  const navigate = useNavigate();
  const detail = useApi<MonthDetail>(`reports/month?month=${ym}&${pq}`);
  const txs = useApi<TxList>(`transactions${qs({ month: ym, limit: 1000, sort: "date_asc", property_id: key })}`);
  const rec = useApi<Recurring>(`recurring?${pq}`);
  const [editing, setEditing] = useState<number | null>(null);
  // /months/2026-11?record=1 (from Add entry) opens the "record bills" dialog straight away
  const [params, setParams] = useSearchParams();
  const [recording, setRecording] = useState(params.get("record") === "1");
  // what the Transactions card shows lives in the URL too, so Back, Add entry and links keep it
  const view = readView(params);
  const setView = (patch: Partial<MonthView>) => setParams(withView(params, patch), { replace: true });
  const clearRecord = () => {
    if (!params.has("record")) return;
    const next = new URLSearchParams(params);
    next.delete("record");
    setParams(next, { replace: true });
  };
  // paging to another month keeps the filter, so "Expenses" stays on while you look back
  const monthPath = (m: string) => scoped(`/months/${m}${viewSearch(params)}`);
  useMonthKeys(!editing && !recording, (delta) => void navigate(monthPath(shiftMonth(ym, delta))));
  const [compareOpen, setCompareOpen] = useState(false);
  const reload = () => {
    void detail.reload();
    void txs.reload();
    void rec.reload();
  };
  const d = detail.data;
  const isFuture = ym > thisMonth();
  const year = ym.slice(0, 4);
  const unpaid =
    d?.recurring.items.filter((i) => i.kind === "expense" && (i.state === "missing" || i.state === "upcoming"))
      .length ?? 0;
  const narrowed = isNarrowed(view);
  const exportQuery = qs({ month: ym, ...exportFilters(view) });
  // a tile is a shortcut for the matching filter (and back to everything when pressed again)
  const tileFilter = (show: "income" | "expense") => setView({ show: view.show === show ? "all" : show });

  return (
    <div className="page">
      <header className="page-head">
        <MonthNav ym={ym} to={monthPath} />
        <div className="head-actions">
          <Link className="btn" to={scoped(`/?year=${year}`)}>
            All of {year}
          </Link>
          <Link className="btn" to={scoped(`/files?month=${ym}`)}>
            Files
          </Link>
          <a
            className="btn"
            href={apiUrl(`/api/export/transactions.csv${exportQuery}&${pq}`)}
            title={narrowed ? "Downloads the entries the filters show" : "Downloads every entry this month"}
          >
            {narrowed ? "Export CSV (filtered)" : "Export CSV"}
          </a>
          {canWrite && (
            <Link
              className="btn primary"
              to={scoped(
                `/add${qs({ date: ym === thisMonth() ? undefined : `${ym}-01`, back: `/months/${ym}${viewSearch(params)}` })}`,
              )}
            >
              + Add
            </Link>
          )}
        </div>
      </header>
      {detail.error && <div className="alert error">{detail.error}</div>}

      {d && (
        <>
          <div className={`tiles tiles-3 ${compareOpen ? "tiles-open" : ""}`}>
            <button
              className={`tile tile-btn ${view.show === "income" ? "on" : ""}`}
              aria-pressed={view.show === "income"}
              title="Show only income"
              onClick={() => tileFilter("income")}
            >
              <span className="tile-label">Income</span>
              <span className="tile-value pos">{money(d.totals.income)}</span>
              <Compare
                label={monthShort(d.compare.previous_month.month)}
                now={d.totals.income}
                then={d.compare.previous_month.income}
                goodWhenUp
              />
              <Compare
                label={monthShort(d.compare.same_month_last_year.month)}
                now={d.totals.income}
                then={d.compare.same_month_last_year.income}
                goodWhenUp
              />
              <span className="tile-sub">12-month avg: {money0(d.compare.avg_12.income)}</span>
            </button>
            <button
              className={`tile tile-btn ${view.show === "expense" ? "on" : ""}`}
              aria-pressed={view.show === "expense"}
              title="Show only expenses"
              onClick={() => tileFilter("expense")}
            >
              <span className="tile-label">Expenses</span>
              <span className="tile-value neg">{money(d.totals.expense)}</span>
              <Compare
                label={monthShort(d.compare.previous_month.month)}
                now={d.totals.expense}
                then={d.compare.previous_month.expense}
                goodWhenUp={false}
              />
              <Compare
                label={monthShort(d.compare.same_month_last_year.month)}
                now={d.totals.expense}
                then={d.compare.same_month_last_year.expense}
                goodWhenUp={false}
              />
              <span className="tile-sub">12-month avg: {money0(d.compare.avg_12.expense)}</span>
            </button>
            <button className="tile tile-btn" title="Show everything" onClick={() => setView({ show: "all" })}>
              <span className="tile-label">Net</span>
              <span className={`tile-value ${d.totals.net < 0 ? "neg" : ""}`}>{money(d.totals.net)}</span>
              <Compare
                label={monthShort(d.compare.previous_month.month)}
                now={d.totals.net}
                then={d.compare.previous_month.net}
                goodWhenUp
              />
              <Compare
                label={monthShort(d.compare.same_month_last_year.month)}
                now={d.totals.net}
                then={d.compare.same_month_last_year.net}
                goodWhenUp
              />
              <span className="tile-sub">
                {d.occupancy
                  ? `${d.occupancy.nights_booked} nights booked · ${d.occupancy.check_ins} check-ins`
                  : `12-month avg: ${money0(d.compare.avg_12.net)}`}
              </span>
            </button>
          </div>
          <button
            className="link small compare-toggle"
            aria-expanded={compareOpen}
            onClick={() => setCompareOpen((v) => !v)}
          >
            {compareOpen ? "Hide comparisons" : "Compare with other months"}
          </button>
        </>
      )}

      {d && (d.recurring.items.length > 0 || d.recurring.alerts.length > 0) && (
        <RecurringCard
          detail={d}
          series={rec.data?.series}
          ym={ym}
          future={isFuture}
          canWrite={canWrite}
          unpaid={unpaid}
          onRecord={() => setRecording(true)}
          onChanged={reload}
          onOpen={setEditing}
        />
      )}

      {d && txs.data && (
        <MonthTransactions
          detail={d}
          items={txs.data.items}
          ym={ym}
          view={view}
          setView={setView}
          showProperty={key === "all"}
          onOpen={setEditing}
          onChanged={reload}
        />
      )}

      {editing && <TxEditModal id={editing} onClose={() => setEditing(null)} onChanged={reload} />}
      {recording && d && (
        <RecordBills
          ym={ym}
          items={d.recurring.items}
          onClose={() => {
            setRecording(false);
            clearRecord();
          }}
          onDone={() => {
            setRecording(false);
            clearRecord();
            reload();
          }}
        />
      )}
    </div>
  );
}

const STATE_ICON: Record<ChecklistItem["state"], string> = { paid: "✓", missing: "?", upcoming: "…", skipped: "–" };
const STATE_TEXT: Record<ChecklistItem["state"], string> = {
  paid: "Paid",
  missing: "Missing",
  upcoming: "Expected",
  skipped: "Marked fine",
};

const isDone = (i: ChecklistItem) => i.state === "paid" || i.state === "skipped";

/**
 * Recurring bills. Done ones fold away. When nothing needs attention (no alerts, nothing missing, only a few bills
 * still to come) the whole card is one line; "Show done" opens the full list.
 */
function RecurringCard({
  detail,
  series,
  ym,
  future,
  canWrite,
  unpaid,
  onRecord,
  onChanged,
  onOpen,
}: {
  detail: MonthDetail;
  series: Recurring["series"] | undefined;
  ym: string;
  future: boolean;
  canWrite: boolean;
  unpaid: number;
  onRecord: () => void;
  onChanged: () => void;
  onOpen: (id: number) => void;
}) {
  const scoped = useScopedPath();
  const [showDone, setShowDone] = useState(false);
  const { items, alerts } = detail.recurring;
  const shownAlerts = alerts.filter((a) => a.type !== "missing");
  const open = items.filter((i) => !isDone(i));
  const doneCount = items.length - open.length;
  const recorded = items.filter((i) => i.state === "paid").length;
  const summary = `${recorded} of ${items.length} ${future ? "expected" : "recorded"}`;
  const toggle =
    doneCount > 0 ? (
      <button className="link" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
        {showDone ? `Hide ${doneCount} done` : `Show ${doneCount} done`}
      </button>
    ) : null;
  const recordButton = canWrite && unpaid > 0 && (
    <button className="btn small primary" onClick={onRecord}>
      Record {unpaid} {unpaid === 1 ? "bill" : "bills"}
    </button>
  );
  const allLink = (
    <Link to={scoped("/recurring")} className="link">
      All recurring →
    </Link>
  );

  const calm = shownAlerts.length === 0 && open.every((i) => i.state === "upcoming") && open.length <= 3;
  if (calm && !showDone) {
    return (
      <section className="card recur-line">
        <p>
          <strong>Recurring</strong>{" "}
          <span className="muted">
            {open.length === 0 ? (
              <>
                all {items.length} {future ? "expected" : "recorded"} ✓
              </>
            ) : (
              <>
                {summary} · still to come:{" "}
                {open.map((i, n) => (
                  <span key={i.series_key}>
                    {n > 0 && ", "}
                    {i.label} ≈ {money(Math.abs(i.typical_amount))}{" "}
                    <small>({fmtDate(i.expected_date).replace(/, \d{4}$/, "")})</small>
                  </span>
                ))}
              </>
            )}
          </span>
        </p>
        <span className="head-actions">
          {recordButton}
          {toggle}
          {allLink}
        </span>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="section-head">
        <h2>Recurring bills &amp; income</h2>
        <span className="head-actions">
          {recordButton}
          {allLink}
        </span>
      </div>
      {shownAlerts.length > 0 && series && <AttentionList alerts={shownAlerts} series={series} onChanged={onChanged} />}
      <p className="muted small bill-summary">
        {summary}
        {toggle && <> · {toggle}</>}
      </p>
      <Checklist items={showDone ? items : open} ym={ym} onChanged={onChanged} onOpen={onOpen} />
    </section>
  );
}

function Checklist({
  items,
  ym,
  onChanged,
  onOpen,
}: {
  items: ChecklistItem[];
  ym: string;
  onChanged: () => void;
  onOpen: (id: number) => void;
}) {
  const scoped = useScopedPath();
  const { canWrite } = useSession();
  const toast = useToast();
  const fine = async (i: ChecklistItem) => {
    await dismissRecurring(i.series_key, ym);
    toast({ text: `OK, nothing expected for ${i.label} this month`, kind: "ok" });
    onChanged();
  };
  return (
    <ul className="bill-list">
      {items.map((i) => (
        <li key={i.series_key} className={`bill ${i.state}`}>
          <span className="bill-icon" title={STATE_TEXT[i.state]}>
            {STATE_ICON[i.state]}
          </span>
          <span className="bill-name">
            {i.ids.length ? (
              <button className="link" onClick={() => onOpen(i.ids[0]!)}>
                {i.label}
              </button>
            ) : (
              i.label
            )}
            <small className="muted">
              {" "}
              · {i.cadence_label.toLowerCase()} · {i.state === "paid" ? "paid" : "due"} around{" "}
              {fmtDate(i.expected_date).replace(/, \d{4}$/, "")}
            </small>
          </span>
          <span className="bill-amount">
            {i.amount != null ? (
              <Amount value={i.amount} />
            ) : (
              <span className="muted">≈ {money(Math.abs(i.typical_amount))}</span>
            )}
          </span>
          {canWrite && i.state === "missing" && (
            <span className="bill-actions">
              <Link className="btn small" to={scoped(addLinkFor(i, i.expected_date, `/months/${ym}`))}>
                Add
              </Link>
              <button className="btn small ghost" onClick={() => void fine(i)}>
                Nothing was due
              </button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
