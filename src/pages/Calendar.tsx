import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api.ts";
import {
  ago,
  monthWeeks,
  syncText,
  weekdayNames,
  type Feed,
  type HistorySummary,
  type SyncResult,
} from "../calendar.ts";
import { fmtDate, monthTitle, shiftMonth, thisMonth, today } from "../format.ts";
import { propertySettingsPath } from "../scope.ts";
import { useApi, usePersistentState, useScopedPath, useSession, useToast, useProperty } from "../hooks.ts";
import { Modal } from "../lib.tsx";
import { KindToggle } from "../components/OwnerStays.tsx";
import { MonthNav } from "../components/MonthPicker.tsx";
import { saveOwnerStay, type StayKind } from "../owner-stays.ts";

type Kind = "reserved" | "blocked";

interface CalEvent {
  id: number;
  feed_id: number | null;
  source: "feed" | "history" | "statement";
  feed: string;
  kind: Kind;
  start_date: string;
  end_date: string;
  nights: number;
  summary: string;
}

interface MonthSummary {
  month: string;
  nights: number;
  booked_nights: number;
  blocked_nights: number;
  free_nights: number;
  check_ins: number;
}

interface CalendarData {
  property_id: number;
  events: CalEvent[];
  nights: Record<string, number>;
  months: MonthSummary[];
  feeds: Feed[];
  history: HistorySummary;
}

const KIND_LABEL: Record<Kind, string> = { reserved: "Booked", blocked: "Not available" };

/** Where in a day (0 = start, 1 = end) a bar begins on check-in and ends on checkout: guests leave in the morning. */
const CHECK_IN_AT = 0.5;
const CHECK_OUT_AT = 0.35;
const DAY_MS = 86_400_000;
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** "Thu, Dec 3, 2026" */
const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const eventLabel = (e: CalEvent) => e.summary || KIND_LABEL[e.kind];

const historyText = (h: HistorySummary) =>
  "; past stays from " +
  [h.stays && "a reservations export", h.statement_stays && "manager statements"].filter(Boolean).join(" and ");

/** Read-only availability from the imported Airbnb/VRBO calendars. */
export default function Calendar() {
  const { canWrite, settings } = useSession();
  const toast = useToast();
  const propertyId = useProperty().single;
  // The month is in the address (?month=), so links can open one and Back steps through them; without one, the
  // month last looked at on this device.
  const linked = useSearchParams()[0].get("month");
  const [saved] = usePersistentState("cal-month", thisMonth());
  const month = linked && /^\d{4}-\d{2}$/.test(linked) ? linked : saved;
  useEffect(() => localStorage.setItem("cal-month", JSON.stringify(month)), [month]);
  const scoped = useScopedPath();
  const monthPath = (m: string) => scoped(`/calendar?month=${m}`);
  // the month before and after come along so bars reach into the greyed days at the edges of the grid
  const { data, reload } = useApi<CalendarData>(
    `calendar?from=${shiftMonth(month, -1)}&to=${shiftMonth(month, 1)}&property_id=${propertyId}`,
  );
  const [open, setOpen] = useState<CalEvent | null>(null);
  const [help, setHelp] = useState(false);
  const [stayKind, setStayKind] = useState<StayKind>("owner");

  // A blocked range the owner (or family) actually stayed: it becomes an owner stay (personal days).
  const markOwnerStay = async (e: CalEvent) => {
    try {
      await saveOwnerStay(toast, {
        property_id: propertyId,
        start_date: e.start_date,
        end_date: e.end_date,
        kind: stayKind,
      });
      setOpen(null);
      setStayKind("owner");
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };

  // Pick up new reservations when the page opens: linked calendars not synced in the last 3 hours.
  // Viewers can't write, so they see what was last synced.
  const autoRefreshed = useRef(false);
  useEffect(() => {
    if (!canWrite || autoRefreshed.current) return;
    autoRefreshed.current = true;
    api<SyncResult[]>(`calendar/refresh?property_id=${propertyId}`, { method: "POST", json: { stale_minutes: 180 } })
      .then((rs) => {
        if (rs.length) void reload();
      })
      .catch(() => {});
  }, [canWrite, propertyId, reload]);

  const refreshAll = async () => {
    try {
      const rs = await api<SyncResult[]>(`calendar/refresh?property_id=${propertyId}`, { method: "POST", json: {} });
      if (!rs.length) toast({ text: "No linked calendars to refresh", kind: "ok" });
      for (const r of rs) toast({ text: syncText(r), kind: r.error ? "error" : "ok" });
      void reload();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };

  const s = data?.months[1];
  const all = data?.events ?? [];
  const byId = new Map(all.map((e) => [e.id, e]));
  const first = `${month}-01`;
  const nextFirst = `${shiftMonth(month, 1)}-01`;
  // A block covered by a reservation (the other platform's mirror of it) adds nothing to the list.
  const holding = new Set(
    Object.entries(data?.nights ?? {})
      .filter(([d]) => d.startsWith(month))
      .map(([, id]) => id),
  );
  const inMonth = all.filter((e) => e.start_date < nextFirst && e.end_date > first);
  const events = inMonth.filter((e) => holding.has(e.id));
  const hidden = inMonth.length - events.length;

  // grid: from the first day of the week the 1st falls in to the last day of the week the month ends in, one row per
  // week; the week starts on the day the person chose in Settings → Preferences
  const weeks = monthWeeks(month, settings.week_start);
  const now = today();

  // A stay is drawn as one bar from the middle of the check-in day to the morning of the checkout day (the day after
  // its last night), cut at the end of each week row. Bars follow the nights an event holds, so a block partly
  // covered by a reservation only draws where it holds the night. Positions are in day columns (0-7).
  const bars = (week: string[]) => {
    const night = (d: string) => data?.nights[d];
    const out: { ev: CalEvent; from: number; to: number; starts: boolean; ends: boolean }[] = [];
    const push = (id: number | undefined, from: number, to: number, starts: boolean, ends: boolean) => {
      const ev = id === undefined ? undefined : byId.get(id);
      if (ev) out.push({ ev, from, to, starts, ends });
    };
    for (let i = 0; i < 7;) {
      const id = night(week[i]!);
      if (id === undefined) {
        i++;
        continue;
      }
      let j = i;
      while (j < 6 && night(week[j + 1]!) === id) j++;
      const starts = night(addDays(week[i]!, -1)) !== id;
      const ends = night(addDays(week[j]!, 1)) !== id;
      // a checkout on the next row's first day is drawn there, as half a bar
      push(id, starts ? i + CHECK_IN_AT : i, ends && j < 6 ? j + 1 + CHECK_OUT_AT : 7, starts, ends && j < 6);
      i = j + 1;
    }
    const before = night(addDays(week[0]!, -1));
    if (before !== undefined && before !== night(week[0]!)) push(before, 0, CHECK_OUT_AT, false, true);
    return out;
  };

  return (
    <div className="page">
      <header className="page-head">
        <MonthNav ym={month} to={monthPath} />
        <button
          className="cal-info-btn"
          onClick={() => setHelp(!help)}
          aria-expanded={help}
          aria-controls="cal-help"
          aria-label="About this calendar"
          title="About this calendar"
        >
          i
        </button>
        <div className="head-actions"></div>
      </header>
      {help && (
        <div id="cal-help" className="cal-help card">
          <ul>
            <li>
              Shows when the house is booked or free, from your Airbnb and VRBO calendars. Past stays also come from an
              imported reservations export and your manager statements.
            </li>
            <li>
              Each bar runs from check-in to checkout, so the checkout day is free for the next guest. Click a bar for
              details.
            </li>
            <li>
              A hatched bar means the dates are blocked on a platform. The calendar can&apos;t tell whether that is an
              owner stay, a hold or another platform&apos;s guest. Click it and choose &quot;Mark as owner stay&quot; if
              you stayed.
            </li>
          </ul>
        </div>
      )}

      {s && (
        <dl className="cal-stats" aria-label={`${monthTitle(month)} summary`}>
          <div>
            <dd>
              {s.booked_nights}
              <span className="muted"> / {s.nights}</span>
            </dd>
            <dt>Booked nights</dt>
          </div>
          <div>
            <dd>{s.free_nights}</dd>
            <dt>Free nights</dt>
          </div>
          <div title="Blocked on a platform, not booked">
            <dd>{s.blocked_nights}</dd>
            <dt>Not available</dt>
          </div>
          <div>
            <dd>{s.check_ins}</dd>
            <dt>Check-ins</dt>
          </div>
        </dl>
      )}

      <div className="cal-nav">
        <div className="cal-legend" aria-hidden="true">
          {(["reserved", "blocked"] as const).map((k) => (
            <span key={k}>
              <i className={`cal-swatch k-${k}`} />
              {KIND_LABEL[k]}
            </span>
          ))}
          <span>
            <i className="cal-swatch" />
            Free
          </span>
        </div>
      </div>

      <div className="card cal-card">
        <div className="cal-grid" role="grid" aria-label={monthTitle(month)}>
          <div className="cal-wds">
            {weekdayNames(settings.week_start).map((w) => (
              <div key={w} className="cal-wd" role="columnheader">
                {w}
              </div>
            ))}
          </div>
          {weeks.map((week) => (
            <div key={week[0]} className="cal-week" role="row">
              {week.map((d) => (
                <div
                  key={d}
                  role="gridcell"
                  className={[
                    "cal-day",
                    d.startsWith(month) ? "" : "out",
                    d === now ? "today" : "",
                    d < now ? "past" : "",
                  ].join(" ")}
                >
                  <span className="cal-num">{Number(d.slice(8))}</span>
                </div>
              ))}
              {bars(week).map((b, n) => (
                <button
                  key={`${b.ev.id}-${n}`}
                  className={["cal-bar", `k-${b.ev.kind}`, b.starts ? "starts" : "", b.ends ? "ends" : ""].join(" ")}
                  style={{ left: `${(b.from / 7) * 100}%`, width: `${((b.to - b.from) / 7) * 100}%` }}
                  onClick={() => setOpen(b.ev)}
                  aria-label={`${KIND_LABEL[b.ev.kind]}: ${eventLabel(b.ev)}, ${fmtDate(b.ev.start_date)} to ${fmtDate(b.ev.end_date)}`}
                  title={`${eventLabel(b.ev)} · ${fmtDate(b.ev.start_date)} to ${fmtDate(b.ev.end_date)}`}
                >
                  {b.starts && <span className="cal-label">{eventLabel(b.ev)}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <p className="muted small cal-sources">
        {!data ? null : !data.feeds.length ? (
          <>
            No booking calendars yet{data.history.stays + data.history.statement_stays ? historyText(data.history) : ""}
            .{" "}
          </>
        ) : (
          <>
            From{" "}
            {data.feeds.map((f, n) => (
              <span key={f.id}>
                {n > 0 && ", "}
                {f.name} <span title={f.last_synced_at ?? ""}>(synced {ago(f.last_synced_at)})</span>
                {f.last_error && <span className="neg"> {f.last_error}</span>}
              </span>
            ))}
            {data.history.stays + data.history.statement_stays ? historyText(data.history) : ""}.{" "}
          </>
        )}
        {canWrite && data?.feeds.some((f) => f.url) && (
          <>
            <button className="link small" onClick={() => void refreshAll()}>
              Refresh now
            </button>
            {" · "}
          </>
        )}
        <Link className="link small" to={propertySettingsPath(propertyId)}>
          {data && !data.feeds.length ? "Add one in this property's settings" : "Manage calendars"}
        </Link>
      </p>

      <section className="card">
        <h2 className="section-head">Bookings in {monthTitle(month)}</h2>
        {hidden > 0 && (
          <p className="muted small">
            {hidden} block{hidden === 1 ? "" : "s"} hidden: a booking already covers those nights (each platform blocks
            the other&apos;s reservations).
          </p>
        )}
        {!events.length ? (
          <p className="empty">Nothing booked or blocked this month.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Check-in</th>
                <th className="hide-sm">Checkout</th>
                <th className="num">Nights</th>
                <th>What</th>
                <th className="hide-sm">From</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="cal-row" onClick={() => setOpen(e)}>
                  <td className="nowrap">{fmtDate(e.start_date)}</td>
                  <td className="nowrap hide-sm">{fmtDate(e.end_date)}</td>
                  <td className="num">{e.nights}</td>
                  <td>
                    <span className={`cal-swatch k-${e.kind}`} /> {eventLabel(e)}
                  </td>
                  <td className="hide-sm muted">{e.feed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {open && (
        <Modal title={open.kind === "reserved" ? "Reservation" : "Not available"} onClose={() => setOpen(null)}>
          <div className="cal-stay">
            <div>
              <span className="muted small">Check-in</span>
              <strong>{fmtDay(open.start_date)}</strong>
            </div>
            <span className="cal-stay-arrow" aria-hidden="true">
              →
            </span>
            <div>
              <span className="muted small">Checkout</span>
              <strong>{fmtDay(open.end_date)}</strong>
            </div>
            <span className="cal-stay-nights">
              {open.nights} night{open.nights === 1 ? "" : "s"}
            </span>
          </div>
          <dl className="kv cal-kv">
            <dt>Status</dt>
            <dd>
              <span className={`cal-swatch k-${open.kind}`} /> {KIND_LABEL[open.kind]}
            </dd>
            <dt>Source</dt>
            <dd>{open.feed}</dd>
            {open.kind === "reserved" && open.summary && (
              <>
                <dt>Details</dt>
                <dd>{open.summary}</dd>
              </>
            )}
          </dl>
          {open.kind === "blocked" && (
            <p className="muted small">
              The platform only says these nights are blocked. It could be an owner stay, a hold, or another
              platform&apos;s guest.
              {canWrite && " If you stayed here, record it below so the nights count as personal use."}
            </p>
          )}
          {open.kind === "blocked" && canWrite && (
            <div className="cal-stay-form">
              <span className="muted small">Who stayed?</span>
              <KindToggle value={stayKind} onChange={setStayKind} />
              <button className="btn primary" onClick={() => void markOwnerStay(open)}>
                Mark as owner stay
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
