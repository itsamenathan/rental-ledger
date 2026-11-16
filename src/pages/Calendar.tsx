import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { fmtDate, monthTitle, shiftMonth, thisMonth, today } from "../format.ts";
import { useApi, usePersistentState, useSession, useToast } from "../hooks.ts";
import { Modal } from "../lib.tsx";

type Kind = "reserved" | "blocked";

interface CalEvent {
  id: number;
  feed_id: number;
  feed: string;
  kind: Kind;
  start_date: string;
  end_date: string;
  nights: number;
  summary: string;
}

interface Feed {
  id: number;
  name: string;
  url: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  events: number;
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
}

interface SyncResult {
  name: string;
  added: number;
  updated: number;
  removed: number;
  error?: string;
}

const KIND_LABEL: Record<Kind, string> = { reserved: "Booked", blocked: "Not available" };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86_400_000;
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

function ago(iso: string | null) {
  if (!iso) return "never";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return fmtDate(iso.slice(0, 10));
}

function syncText(r: SyncResult) {
  if (r.error) return `${r.name}: ${r.error}`;
  const parts = [
    r.added && `${r.added} new`,
    r.updated && `${r.updated} changed`,
    r.removed && `${r.removed} cancelled`,
  ].filter(Boolean);
  return `${r.name}: ${parts.length ? parts.join(", ") : "no changes"}`;
}

const eventLabel = (e: CalEvent) => e.summary || KIND_LABEL[e.kind];

/** Read-only availability from the imported Airbnb/VRBO calendars. */
export default function Calendar() {
  const { overview, canWrite } = useSession();
  const toast = useToast();
  const props = overview.properties.filter((p) => !p.archived);
  const [propertyId, setPropertyId] = useState(props[0]?.id ?? 0);
  const [month, setMonth] = usePersistentState("cal-month", thisMonth());
  const { data, reload } = useApi<CalendarData>(`calendar?from=${month}&property_id=${propertyId}`);
  const [open, setOpen] = useState<CalEvent | null>(null);
  const [feedForm, setFeedForm] = useState<Feed | "new" | null>(null);

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
        <div className="head-actions">
          {props.length > 1 && (
            <select value={propertyId} onChange={(e) => setPropertyId(Number(e.target.value))} aria-label="Property">
              {props.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>
      <p className="muted">
        When the house is booked or free, from your Airbnb/VRBO calendars. Each day shows that night; the checkout day
        is free for the next guest. Private bookings and owner stays only show if you blocked the dates on a platform.
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

      <section className="card">
        <div className="section-head cal-feeds-head">
          <h2>Imported calendars</h2>
          <span className="spacer" />
          {canWrite && (data?.feeds ?? []).some((f) => f.url) && (
            <button className="btn small" onClick={() => void refreshAll()}>
              Refresh all
            </button>
          )}
          {canWrite && (
            <button className="btn small primary" onClick={() => setFeedForm("new")}>
              Add calendar
            </button>
          )}
        </div>
        {!data?.feeds.length ? (
          <p className="empty">
            No calendars yet. Add your Airbnb or VRBO calendar link and its reservations show up here.
          </p>
        ) : (
          <ul className="cal-feeds">
            {data.feeds.map((f) => (
              <FeedRow key={f.id} feed={f} onEdit={() => setFeedForm(f)} onChanged={reload} />
            ))}
          </ul>
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
      {feedForm && (
        <FeedForm
          propertyId={propertyId}
          feed={feedForm === "new" ? null : feedForm}
          onClose={() => setFeedForm(null)}
          onSaved={() => {
            setFeedForm(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function FeedRow({ feed, onEdit, onChanged }: { feed: Feed; onEdit: () => void; onChanged: () => void }) {
  const { canWrite } = useSession();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<SyncResult>) => {
    setBusy(true);
    try {
      const r = await fn();
      toast({ text: syncText(r), kind: r.error ? "error" : "ok" });
      onChanged();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => run(() => api<SyncResult>(`calendar/feeds/${feed.id}/refresh`, { method: "POST" }));
  const importFile = (f: File) =>
    run(async () =>
      api<SyncResult>(`calendar/feeds/${feed.id}/import`, {
        method: "POST",
        body: await f.text(),
        headers: { "content-type": "text/calendar" },
      }),
    );
  const remove = async () => {
    if (!confirm(`Remove "${feed.name}" and the ${feed.events} events imported from it?`)) return;
    try {
      await api(`calendar/feeds/${feed.id}`, { method: "DELETE" });
      onChanged();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };

  return (
    <li>
      <div className="grow">
        <strong>{feed.name}</strong>
        <div className="muted small">
          {feed.url ? "Linked" : "Imported from files"} · {feed.events} events · synced {ago(feed.last_synced_at)}
        </div>
        {feed.last_error && <div className="small neg">{feed.last_error}</div>}
      </div>
      {canWrite && (
        <div className="cal-feed-actions">
          {feed.url && (
            <button className="btn small" disabled={busy} onClick={() => void refresh()}>
              {busy ? "Syncing…" : "Refresh"}
            </button>
          )}
          <button className="btn small ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
            Import .ics
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".ics,text/calendar"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importFile(f);
            }}
          />
          <button className="btn small ghost" onClick={onEdit}>
            Edit
          </button>
          <button className="link small danger" onClick={() => void remove()}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

function FeedForm({
  propertyId,
  feed,
  onClose,
  onSaved,
}: {
  propertyId: number;
  feed: Feed | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(feed?.name ?? "Airbnb");
  const [url, setUrl] = useState(feed?.url ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const saved = feed
        ? await api<Feed>(`calendar/feeds/${feed.id}`, { method: "PATCH", json: { name, url: url.trim() || null } })
        : await api<Feed>("calendar/feeds", {
            method: "POST",
            json: { property_id: propertyId, name, url: url.trim() || null },
          });
      const changedLink = !feed || (url.trim() || null) !== feed.url;
      let r: SyncResult | null = null;
      if (file)
        r = await api<SyncResult>(`calendar/feeds/${saved.id}/import`, {
          method: "POST",
          body: await file.text(),
          headers: { "content-type": "text/calendar" },
        });
      else if (saved.url && changedLink)
        r = await api<SyncResult>(`calendar/feeds/${saved.id}/refresh`, { method: "POST" });
      if (r) toast({ text: syncText(r), kind: r.error ? "error" : "ok" });
      onSaved();
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={feed ? "Edit calendar" : "Add calendar"} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </label>
        <label>
          Calendar link <span className="optional">optional</span>
          <input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.airbnb.com/calendar/ical/….ics?s=…"
          />
          <span className="hint">
            In Airbnb: the listing&apos;s Availability settings → Connect calendars → Export calendar, then copy the
            link. VRBO: Calendar → Import/Export → Export. The link works like a password; only people who can edit see
            it here.
          </span>
        </label>
        <label>
          Or import an .ics file <span className="optional">optional</span>
          <input type="file" accept=".ics,text/calendar" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving}>
            {saving ? "Saving…" : feed ? "Save" : "Add and sync"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
