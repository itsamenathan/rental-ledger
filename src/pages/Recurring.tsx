import { Link } from "react-router";
import { api, dismissRecurring, type Recurring, type RecurringSeries } from "../api.ts";
import { fmtDate, money, monthLabel, monthShort, shiftMonth, thisMonth } from "../format.ts";
import { useApi, useSession, useToast } from "../hooks.ts";

const STATUS: Record<RecurringSeries["status"], { text: string; cls: string }> = {
  ok: { text: "Up to date", cls: "ok" },
  due: { text: "Due now", cls: "info" },
  missing: { text: "Missing", cls: "warn" },
  stopped: { text: "Stopped?", cls: "muted" },
  ignored: { text: "Not tracked", cls: "muted" },
};

/** Last 12 months for one series: paid, missing, not expected. */
function Strip({ s }: { s: RecurringSeries }) {
  const end = thisMonth();
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(end, i - 11));
  const paid = new Map(s.history.map((h) => [h.month, h]));
  const expected = new Set(s.expected_months);
  const missing = new Set(s.missing_months);
  return (
    <span className="strip" aria-label="Last 12 months">
      {months.map((m) => {
        const h = paid.get(m);
        const cls = h ? "paid" : missing.has(m) ? "missing" : expected.has(m) ? "expected" : "none";
        const title = `${monthShort(m)}: ${h ? money(h.amount) : cls === "missing" ? "missing" : cls === "expected" ? "expected" : "not due"}`;
        return (
          <Link key={m} to={`/months/${m}`} className={`dot ${cls}`} title={title}>
            <span>{monthLabel(m).slice(0, 1)}</span>
          </Link>
        );
      })}
    </span>
  );
}

export default function RecurringPage() {
  const { data, error, reload } = useApi<Recurring>("recurring");
  const { canWrite } = useSession();
  const toast = useToast();

  const tracked = data?.series.filter((s) => s.status !== "ignored" && s.status !== "stopped") ?? [];
  const inactive = data?.series.filter((s) => s.status === "ignored" || s.status === "stopped") ?? [];
  const label = (key: string) => data?.series.find((s) => s.key === key)?.label ?? key;
  const monthDismissals = data?.dismissals.filter((d) => d.month) ?? [];

  const ignore = async (s: RecurringSeries) => {
    await dismissRecurring(s.key, null);
    toast({ text: `Stopped tracking ${s.label}`, kind: "ok" });
    void reload();
  };
  const undo = async (id: number) => {
    await api(`recurring/dismissals/${id}`, { method: "DELETE" });
    void reload();
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Recurring</h1>
      </header>
      <p className="muted small">
        Learned automatically from your history: anything with the same category, vendor and subcategory that's been
        paid on a steady schedule (monthly, quarterly, yearly…). If an expected payment doesn't show up, it's flagged
        here and on the overview.
      </p>
      {error && <div className="alert error">{error}</div>}

      {data && data.alerts.length > 0 && (
        <Link to="/todo" className="alert warn link-alert">
          {data.alerts.length} recurring {data.alerts.length === 1 ? "alert" : "alerts"} to check on the To do page →
        </Link>
      )}

      {data && (
        <section className="card table-card">
          <table className="data-table recurring-table">
            <thead>
              <tr>
                <th>Bill / income</th>
                <th>Schedule</th>
                <th className="num">Usually</th>
                <th className="hide-sm">Last</th>
                <th className="hide-sm">Next</th>
                <th className="hide-sm">Last 12 months</th>
                <th>Status</th>
                {canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {tracked.map((s) => (
                <tr key={s.key}>
                  <td>
                    <Link
                      to={`/transactions?year=all&category=${s.category_id}${s.vendor ? `&vendor=${encodeURIComponent(s.vendor)}` : ""}`}
                    >
                      {s.label}
                    </Link>
                  </td>
                  <td className="nowrap">{s.cadence_label}</td>
                  <td className="num nowrap">
                    {s.fixed_amount ? "" : "≈ "}
                    {money(Math.abs(s.typical_amount))}
                  </td>
                  <td className="hide-sm nowrap muted">{fmtDate(s.last_date)}</td>
                  <td className="hide-sm nowrap">{fmtDate(s.next_due)}</td>
                  <td className="hide-sm">
                    <Strip s={s} />
                  </td>
                  <td>
                    <span className={`badge ${STATUS[s.status].cls}`}>{STATUS[s.status].text}</span>
                  </td>
                  {canWrite && (
                    <td>
                      <button className="link small" onClick={() => void ignore(s)} title="Stop tracking this series">
                        Stop tracking
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {tracked.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    No recurring payments found yet. They appear after three payments on a steady schedule.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {data && (inactive.length > 0 || monthDismissals.length > 0) && (
        <section className="card">
          <h2>What you've told it</h2>
          <ul className="plain-list">
            {inactive.map((s) => {
              const d = data.dismissals.find((x) => x.series_key === s.key && !x.month);
              return (
                <li key={s.key}>
                  <span>
                    <strong>{s.label}</strong>{" "}
                    <span className="muted small">
                      {s.status === "ignored" ? "not tracked" : `looks like it stopped after ${fmtDate(s.last_date)}`}
                    </span>
                  </span>
                  {canWrite &&
                    (d ? (
                      <button className="link small" onClick={() => void undo(d.id)}>
                        Track again
                      </button>
                    ) : (
                      <button className="link small" onClick={() => void ignore(s)}>
                        Stop tracking
                      </button>
                    ))}
                </li>
              );
            })}
            {monthDismissals.map((d) => (
              <li key={d.id}>
                <span>
                  <strong>{label(d.series_key)}</strong>{" "}
                  <span className="muted small">{monthShort(d.month)} marked as fine</span>
                </span>
                {canWrite && (
                  <button className="link small" onClick={() => void undo(d.id)}>
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
