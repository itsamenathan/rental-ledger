import { useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";
import { ago, syncText, type Feed, type HistoryImport, type HistorySummary, type SyncResult } from "../calendar.ts";
import { fmtDate } from "../format.ts";
import { useApi, useSession, useToast, useConfirm } from "../hooks.ts";
import { Modal } from "../lib.tsx";

/** A property's settings page: its imported booking calendars. */
export function PropertyCalendars({ propertyId }: { propertyId: number }) {
  const { canWrite } = useSession();
  const { data, reload } = useApi<Feed[]>(`calendar/feeds?property_id=${propertyId}`);
  const [form, setForm] = useState<{ feed: Feed | null } | null>(null);
  const feeds = data ?? [];
  return (
    <section className="card">
      <div className="section-head">
        <h2>Booking calendars</h2>
        {canWrite && (
          <button className="btn small" onClick={() => setForm({ feed: null })}>
            + Add calendar
          </button>
        )}
      </div>
      <p className="muted small">
        The Calendar page shows when this property is booked or free from these iCal links. In Airbnb: the
        listing&apos;s Availability settings → Connect calendars → Export calendar. VRBO: Calendar → Import/Export →
        Export. Each link works like a password; only people who can edit see it.
      </p>
      {!data ? null : !feeds.length ? (
        <p className="empty">No calendars yet.</p>
      ) : (
        <ul className="cal-feeds">
          {feeds.map((f) => (
            <FeedRow key={f.id} feed={f} onEdit={() => setForm({ feed: f })} onChanged={() => void reload()} />
          ))}
        </ul>
      )}
      <PastStays propertyId={propertyId} />
      {form && (
        <FeedForm
          propertyId={propertyId}
          feed={form.feed}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            void reload();
          }}
        />
      )}
    </section>
  );
}

function FeedRow({ feed, onEdit, onChanged }: { feed: Feed; onEdit: () => void; onChanged: () => void }) {
  const { canWrite } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
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
    if (
      !(await confirm({
        title: "Remove this calendar?",
        message: `"${feed.name}" and the ${feed.events} events imported from it will be removed.`,
        confirm: "Remove",
        danger: true,
      }))
    )
      return;
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

/** Stays older than what the feeds still show: an imported reservations export, and saved manager statements. */
function PastStays({ propertyId }: { propertyId: number }) {
  const { canWrite } = useSession();
  const toast = useToast();
  const { data, reload } = useApi<HistorySummary>(`calendar/history?property_id=${propertyId}`);
  const [importing, setImporting] = useState(false);
  const confirm = useConfirm();
  const clear = async () => {
    if (
      !data ||
      !(await confirm({
        title: "Remove imported stays?",
        message: `The ${data.stays} stays imported from a reservations export will be removed.`,
        confirm: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      await api(`calendar/history?property_id=${propertyId}`, { method: "DELETE" });
      void reload();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  return (
    <div className="cal-history">
      <h3>Past stays</h3>
      <p className="muted small">
        Airbnb&apos;s calendar link only shows recent and upcoming stays; the calendar keeps each stay once it has seen
        it. For older ones, import Airbnb&apos;s reservations export (Reservations → Export → Download CSV file). Stays
        on saved manager statements show on the calendar too.
      </p>
      {data && (
        <p className="small">
          {data.stays
            ? `${data.stays} stay${data.stays === 1 ? "" : "s"} imported (${fmtDate(data.first!)} – ${fmtDate(data.last!)})`
            : "No reservations export imported"}
          {" · "}
          {data.statement_stays} on manager statements
        </p>
      )}
      {canWrite && (
        <div className="cal-feed-actions">
          <button className="btn small ghost" onClick={() => setImporting(true)}>
            Import reservations CSV
          </button>
          {!!data?.stays && (
            <button className="link small danger" onClick={() => void clear()}>
              Remove imported stays
            </button>
          )}
        </div>
      )}
      {importing && (
        <HistoryForm
          propertyId={propertyId}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function HistoryForm({ propertyId, onClose, onDone }: { propertyId: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [csv, setCsv] = useState<string | null>(null);
  const [listings, setListings] = useState<string[]>([]);
  const [listing, setListing] = useState("");
  const [preview, setPreview] = useState<HistoryImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = (text: string, chosen: string, dryRun: boolean) =>
    api<HistoryImport>("calendar/history", {
      method: "POST",
      json: { property_id: propertyId, csv: text, listing: chosen || undefined, dry_run: dryRun },
    });

  const check = async (text: string, chosen: string) => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const r = await send(text, chosen, true);
      setPreview(r);
      setListings(r.listings);
    } catch (e) {
      const more = e instanceof ApiError ? (e.details as { listings?: string[] } | undefined)?.listings : undefined;
      if (more) setListings(more);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!csv) return;
    setBusy(true);
    try {
      const r = await send(csv, listing, false);
      toast({ text: `Reservation history: ${r.added} added, ${r.updated} updated`, kind: "ok" });
      onDone();
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
      setBusy(false);
    }
  };

  return (
    <Modal title="Import reservation history" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Reservations export (.csv)
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const text = await f.text();
              setCsv(text);
              setListing("");
              setListings([]);
              void check(text, "");
            }}
          />
        </label>
        {listings.length > 1 && (
          <label>
            Listing for this property
            <select
              value={listing}
              onChange={(e) => {
                setListing(e.target.value);
                if (csv && e.target.value) void check(csv, e.target.value);
              }}
              required
            >
              <option value="">Choose…</option>
              {listings.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="small neg">{error}</p>}
        {preview && (
          <p className="small">
            {plural(preview.stays, "past stay")}: {preview.added} new
            {!!preview.updated && `, ${preview.updated} changed`}
            {!!preview.unchanged && `, ${preview.unchanged} already imported`}.
            {!!preview.on_calendar && ` ${plural(preview.on_calendar, "is", "are")} already on a linked calendar.`}
            <span className="muted">
              {" "}
              Skipped: {plural(preview.skipped_cancelled, "cancelled request")},{" "}
              {plural(preview.skipped_upcoming, "upcoming stay")} (the calendar link covers those)
              {!!preview.skipped_other_listings && `, ${plural(preview.skipped_other_listings, "other-listing row")}`}.
            </span>
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !preview || !(preview.added || preview.updated) || (listings.length > 1 && !listing)}
          >
            {busy ? "Working…" : "Import"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
