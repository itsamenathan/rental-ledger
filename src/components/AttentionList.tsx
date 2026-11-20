import { useState } from "react";
import { Link, useLocation } from "react-router";
import { addLinkFor, qs, type RecurringAlert, type RecurringSeries } from "../api.ts";
import { dateInMonth, monthShort } from "../format.ts";
import { useSession, useScopedPath } from "../hooks.ts";
import { useDismissAlert } from "../recurring-dismiss.ts";
import { scopePath } from "../scope.ts";

const ICON: Record<RecurringAlert["type"], string> = {
  missing: "?",
  duplicate: "2×",
  amount_changed: "Δ",
  unusual: "!",
};

/** Recurring-bill alerts with one-click fixes: add the missing entry, or tell the app it's fine. */
export default function AttentionList({
  alerts,
  series,
  limit,
  onChanged,
}: {
  alerts: RecurringAlert[];
  series: RecurringSeries[];
  limit?: number;
  onChanged: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = limit && !showAll ? alerts.slice(0, limit) : alerts;
  if (!alerts.length) return <p className="muted small">Nothing missing. All recurring bills look up to date.</p>;

  return (
    <>
      <ul className="checks attention-list">
        {shown.map((a) => {
          const s = series.find((x) => x.key === a.series_key);
          return (
            <li key={`${a.series_key}|${a.type}|${a.month}`} className={`check-item ${a.level}`}>
              <span className="status-icon">{ICON[a.type]}</span>
              <div className="attention-body">
                <div>{a.message}</div>
                <div className="attention-actions">
                  <RecurringActions alert={a} series={s} onChanged={onChanged} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {limit && alerts.length > limit && (
        <button className="link small" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${alerts.length}`}
        </button>
      )}
    </>
  );
}

/** "Open month", the fix ("Add it" / "Review") and "it's fine" for one alert. Links go to the bill's own property. */
export function RecurringActions({
  alert: a,
  series: s,
  onChanged,
}: {
  alert: RecurringAlert;
  series?: RecurringSeries;
  onChanged: () => void;
}) {
  const scoped = useScopedPath();
  const at = (to: string) => (s ? scopePath(String(s.property_id), to) : scoped(to));
  const { canWrite } = useSession();
  const here = useLocation().pathname;
  const dismiss = useDismissAlert(onChanged);
  return (
    <>
      <Link to={at(`/months/${a.month}`)} className="link small">
        Open {monthShort(a.month)}
      </Link>
      {canWrite && (
        <>
          {a.type === "missing" && s && (
            <Link className="btn small primary" to={at(addLinkFor(s, dateInMonth(a.month, s.expected_day), here))}>
              Add it
            </Link>
          )}
          {a.type === "duplicate" && a.ids && (
            <Link
              className="btn small primary"
              to={at(
                `/transactions${qs({ month: a.month, category: s?.category_id, vendor: s?.vendor || undefined, q: s?.subcategory || undefined })}`,
              )}
            >
              Review
            </Link>
          )}
          <button className="btn small ghost" onClick={() => void dismiss(a, false)}>
            {a.type === "missing" ? "Nothing was due" : a.type === "duplicate" ? "Not a duplicate" : "Looks right"}
          </button>
          {a.type === "missing" && (
            <button className="link small" onClick={() => void dismiss(a, true)}>
              Stop tracking
            </button>
          )}
        </>
      )}
    </>
  );
}
