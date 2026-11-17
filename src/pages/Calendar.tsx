import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { ago, syncText, type Feed, type HistorySummary, type SyncResult } from "../calendar.ts";
import { fmtDate, monthTitle, shiftMonth, thisMonth, today } from "../format.ts";
import { propertySettingsPath } from "../scope.ts";
import { useApi, usePersistentState, useSession, useToast, useProperty } from "../hooks.ts";
import { Modal } from "../lib.tsx";

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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86_400_000;
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const eventLabel = (e: CalEvent) => e.summary || KIND_LABEL[e.kind];

const historyText = (h: HistorySummary) =>
  "; past stays from " +
  [h.stays && "a reservations export", h.statement_stays && "manager statements"].filter(Boolean).join(" and ");

/** Read-only availability from the imported Airbnb/VRBO calendars. */
export default function Calendar() {
  const { canWrite } = useSession();
  const toast = useToast();
  const propertyId = useProperty().single;
  const [month, setMonth] = usePersistentState("cal-month", thisMonth());
  const { data, reload } = useApi<CalendarData>(`calendar?from=${month}&property_id=${propertyId}`);
  const [open, setOpen] = useState<CalEvent | null>(null);

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

  const s = data?.months[0];
  const all = data?.events ?? [];
  const byId = new Map(all.map((e) => [e.id, e]));
  // A block covered by a reservation (the other platform's mirror of it) adds nothing to the list.
  const holding = new Set(Object.values(data?.nights ?? {}));
  const events = all.filter((e) => holding.has(e.id));
  const hidden = all.length - events.length;

  // grid: from the Sunday on/before the 1st to the Saturday on/after the last day
  const first = `${month}-01`;
  const nextFirst = `${shiftMonth(month, 1)}-01`;
  const gridStart = addDays(first, -new Date(`${first}T00:00:00Z`).getUTCDay());
  const lastDay = addDays(nextFirst, -1);
  const gridEnd = addDays(lastDay, 6 - new Date(`${lastDay}T00:00:00Z`).getUTCDay());
  const days: string[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d);
  const now = today();

  const nightOf = (d: string) => {
    const id = data?.nights[d];
    return id ? byId.get(id) : undefined;
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Calendar</h1>
        <div className="head-actions"></div>
      </header>
      <p className="muted">
        When the house is booked or free, from your Airbnb/VRBO calendars, plus past stays from an imported reservations
        export and your manager statements. Each day shows that night; the checkout day is free for the next guest.
        Private bookings and owner stays only show if you blocked the dates on a platform.
      </p>

      <div className="cal-nav">
        <button className="btn small" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
          ‹
        </button>
        <h2>{monthTitle(month)}</h2>
        <button className="btn small" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
          ›
        </button>
        {month !== thisMonth() && (
          <button className="btn small ghost" onClick={() => setMonth(thisMonth())}>
            This month
          </button>
        )}
        <span className="spacer" />
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
          {WEEKDAYS.map((w) => (
            <div key={w} className="cal-wd" role="columnheader">
              {w}
            </div>
          ))}
          {days.map((d, i) => {
            const ev = nightOf(d);
            const inMonth = d.startsWith(month);
            const prev = i % 7 === 0 ? undefined : nightOf(addDays(d, -1));
            const next = i % 7 === 6 ? undefined : nightOf(addDays(d, 1));
            const label = ev ? `${KIND_LABEL[ev.kind]}: ${eventLabel(ev)}` : "Free";
            return (
              <button
                key={d}
                role="gridcell"
                className={[
                  "cal-day",
                  inMonth ? "" : "out",
                  d === now ? "today" : "",
                  d < now ? "past" : "",
                  ev ? `k-${ev.kind}` : "",
                  ev && prev === ev ? "join-l" : "",
                  ev && next === ev ? "join-r" : "",
                ].join(" ")}
                onClick={() => ev && setOpen(ev)}
                disabled={!ev}
                aria-label={`${fmtDate(d)}: ${label}`}
                title={label}
              >
                <span className="cal-num">{Number(d.slice(8))}</span>
                {ev && prev !== ev && <span className="cal-label">{eventLabel(ev)}</span>}
              </button>
            );
          })}
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

      {s && (
        <div className="tiles">
          <div className="tile">
            <span className="tile-label">Booked nights</span>
            <span className="tile-value">{s.booked_nights}</span>
            <span className="tile-sub">of {s.nights}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Free nights</span>
            <span className="tile-value">{s.free_nights}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Not available</span>
            <span className="tile-value">{s.blocked_nights}</span>
            <span className="tile-sub">blocked, not booked</span>
          </div>
          <div className="tile">
            <span className="tile-label">Check-ins</span>
            <span className="tile-value">{s.check_ins}</span>
          </div>
        </div>
      )}

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
        <Modal title={eventLabel(open)} onClose={() => setOpen(null)}>
          <dl className="kv cal-kv">
            <dt>Status</dt>
            <dd>
              <span className={`cal-swatch k-${open.kind}`} /> {KIND_LABEL[open.kind]}
            </dd>
            <dt>Check-in</dt>
            <dd>{fmtDate(open.start_date)}</dd>
            <dt>Checkout</dt>
            <dd>
              {fmtDate(open.end_date)} · {open.nights} night{open.nights === 1 ? "" : "s"}
            </dd>
            <dt>From</dt>
            <dd>{open.feed}</dd>
          </dl>
          {open.kind === "blocked" && (
            <p className="muted small">
              The platform only says these nights aren&apos;t available: another platform&apos;s guest, an owner stay or
              a hold.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
