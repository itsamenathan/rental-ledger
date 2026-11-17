import { useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
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
import RecordBills from "../components/RecordBills.tsx";
import TxEditModal from "../components/TxEditModal.tsx";
import { fmtDate, money, money0, monthShort, monthTitle, shiftMonth, thisMonth } from "../format.ts";
import { useApi, useSession, useToast, useScopedPath, useProperty } from "../hooks.ts";
import { AllocationBadge, Amount } from "../lib.tsx";

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

function Month({ ym }: { ym: string }) {
  const { path: scoped, qs: pq, key } = useProperty();
  const { canWrite } = useSession();
  const detail = useApi<MonthDetail>(`reports/month?month=${ym}&${pq}`);
  const txs = useApi<TxList>(`transactions${qs({ month: ym, limit: 1000, sort: "date_asc", property_id: key })}`);
  const rec = useApi<Recurring>(`recurring?${pq}`);
  const [editing, setEditing] = useState<number | null>(null);
  // /months/2026-11?record=1 (from Add entry) opens the "record bills" dialog straight away
  const [params, setParams] = useSearchParams();
  const [recording, setRecording] = useState(params.get("record") === "1");
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

  return (
    <div className="page">
      <header className="page-head">
        <div className="month-nav">
          <Link className="icon-btn" to={scoped(`/months/${shiftMonth(ym, -1)}`)} aria-label="Previous month">
            ‹
          </Link>
          <h1>{monthTitle(ym)}</h1>
          <Link className="icon-btn" to={scoped(`/months/${shiftMonth(ym, 1)}`)} aria-label="Next month">
            ›
          </Link>
        </div>
        <div className="head-actions">
          <Link className="btn" to={scoped(`/?year=${year}`)}>
            All of {year}
          </Link>
          <Link className="btn" to={scoped(`/files?month=${ym}`)}>
            Files
          </Link>
          <a className="btn" href={`/api/export/transactions.csv?month=${ym}&${pq}`}>
            Export CSV
          </a>
          {canWrite && (
            <Link
              className="btn primary"
              to={scoped(`/add${qs({ date: ym === thisMonth() ? undefined : `${ym}-01`, back: `/months/${ym}` })}`)}
            >
              + Add
            </Link>
          )}
        </div>
      </header>
      {detail.error && <div className="alert error">{detail.error}</div>}

      {d && (
        <div className="tiles tiles-3">
          <div className="tile">
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
          </div>
          <div className="tile">
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
          </div>
          <div className="tile">
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
          </div>
        </div>
      )}

      {d && (d.recurring.items.length > 0 || d.recurring.alerts.length > 0) && (
        <section className="card">
          <div className="section-head">
            <h2>Recurring bills &amp; income</h2>
            <span className="head-actions">
              {canWrite && unpaid > 0 && (
                <button className="btn small primary" onClick={() => setRecording(true)}>
                  Record {unpaid} {unpaid === 1 ? "bill" : "bills"}
                </button>
              )}
              <Link to={scoped("/recurring")} className="link">
                All recurring →
              </Link>
            </span>
          </div>
          {d.recurring.alerts.filter((a) => a.type !== "missing").length > 0 && rec.data && (
            <AttentionList
              alerts={d.recurring.alerts.filter((a) => a.type !== "missing")}
              series={rec.data.series}
              onChanged={reload}
            />
          )}
          <Checklist items={d.recurring.items} ym={ym} future={isFuture} onChanged={reload} onOpen={setEditing} />
        </section>
      )}

      {d && txs.data && (
        <section className="card">
          <h2>By category</h2>
          {txs.data.items.length === 0 ? (
            <p className="muted">Nothing recorded for {monthTitle(ym)}.</p>
          ) : (
            <CategoryGroups detail={d} items={txs.data.items} onOpen={setEditing} />
          )}
        </section>
      )}

      {editing && <TxEditModal id={editing} onClose={() => setEditing(null)} onChanged={reload} />}
      {recording && d && (
        <RecordBills
          ym={ym}
          items={d.recurring.items}
          onClose={() => {
            setRecording(false);
            if (params.has("record")) setParams({}, { replace: true });
          }}
          onDone={() => {
            setRecording(false);
            if (params.has("record")) setParams({}, { replace: true });
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

function Checklist({
  items,
  ym,
  future,
  onChanged,
  onOpen,
}: {
  items: ChecklistItem[];
  ym: string;
  future: boolean;
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
  const paid = items.filter((i) => i.state === "paid").length;
  return (
    <>
      <p className="muted small">
        {paid} of {items.length} {future ? "expected" : "recorded"}
      </p>
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
    </>
  );
}

function CategoryGroups({
  detail,
  items,
  onOpen,
}: {
  detail: MonthDetail;
  items: TxList["items"];
  onOpen: (id: number) => void;
}) {
  const groups = detail.by_category.filter((c) => c.count > 0);
  return (
    <div className="cat-groups">
      {(["income", "expense"] as const).map((kind) => {
        const gs = groups.filter((g) => g.kind === kind);
        if (!gs.length) return null;
        return (
          <div key={kind}>
            <h3 className="group-title">
              {kind === "income" ? "Income" : "Expenses"}
              <span>{money(kind === "income" ? detail.totals.income : -detail.totals.expense)}</span>
            </h3>
            {gs.map((g) => {
              const rows = items.filter((t) => t.category_id === g.category_id);
              const vsAvg = Math.abs(g.amount) - Math.abs(g.avg_12);
              return (
                <details key={g.category_id} className="cat-group" open>
                  <summary>
                    <span className="cat-name">
                      {g.category} <small className="muted">({g.count})</small>
                    </span>
                    <span className="cat-compare muted small">
                      avg {money0(Math.abs(g.avg_12))}
                      {Math.abs(g.avg_12) > 0 && Math.abs(vsAvg) >= 1 && (
                        <span className={`delta ${vsAvg > 0 === (kind === "income") ? "good" : "bad"}`}>
                          {" "}
                          {vsAvg > 0 ? "▲" : "▼"} {money0(Math.abs(vsAvg))}
                        </span>
                      )}
                    </span>
                    <Amount value={g.amount} />
                  </summary>
                  <ul className="tx-mini">
                    {rows.map((t) => (
                      <li key={t.id}>
                        <button className="row-btn" onClick={() => onOpen(t.id)}>
                          <span>{fmtDate(t.date)}</span>
                          <span>
                            {t.vendor || t.subcategory || t.description || t.category}
                            {t.vendor && t.subcategory && <small> · {t.subcategory}</small>}
                            {t.description && (t.vendor || t.subcategory) && <small> · {t.description}</small>}
                            {t.needs_review && <span className="badge warn"> ⚑</span>}
                          </span>
                          <AllocationBadge value={t.allocation} />
                          <Amount value={t.amount} />
                        </button>
                      </li>
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
