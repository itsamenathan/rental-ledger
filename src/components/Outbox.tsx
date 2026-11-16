import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Transaction } from "../api.ts";
import { fmtDate, money } from "../format.ts";
import { Modal } from "../lib.tsx";
import TxForm from "./TxForm.tsx";
import { OutboxCtx, useOutbox, useSession, useToast } from "../hooks.ts";
import {
  asText,
  discardOutbox,
  holdEntry,
  keepMine,
  keepTheirs,
  listOutbox,
  OUTBOX_EVENT,
  releaseEntry,
  retryOutbox,
  syncOutbox,
  type OutboxEntry,
} from "../outbox.ts";

/** While anything is waiting, try again this often (the app can't sync in the background, notably on iOS). */
const RETRY_MS = 30_000;

/** Keeps the offline outbox listed and sends it whenever there's a chance of a connection. */
export function OutboxProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const toast = useToast();
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const busy = useRef(false);

  const load = useCallback(() => {
    listOutbox(user.id)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [user.id]);

  const syncNow = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setSyncing(true);
    try {
      const r = await syncOutbox(user.id);
      if (r.synced) {
        toast({ text: `Synced ${r.synced} saved-offline ${r.synced === 1 ? "entry" : "entries"}`, kind: "ok" });
        window.dispatchEvent(new Event("todo:changed"));
      }
      if (r.failed)
        toast({ text: `${r.failed} offline ${r.failed === 1 ? "entry needs" : "entries need"} a look`, kind: "error" });
      // navigator.onLine can't be trusted either way (captive wifi, no signal but "connected"); results can.
      if (r.offline) setOnline(false);
      else if (r.synced) setOnline(true);
    } catch {
      /* storage unavailable: nothing to send */
    } finally {
      busy.current = false;
      setSyncing(false);
      load();
    }
  }, [user.id, toast, load]);

  useEffect(() => {
    load();
    const first = setTimeout(() => void syncNow(), 0); // after the first paint
    const onChange = () => load();
    const onOnline = () => {
      setOnline(true);
      void syncNow();
    };
    const onOffline = () => setOnline(false);
    const onVisible = () => document.visibilityState === "visible" && void syncNow();
    window.addEventListener(OUTBOX_EVENT, onChange);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      window.removeEventListener(OUTBOX_EVENT, onChange);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, syncNow]);

  const waiting = entries.some((e) => !e.error);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void syncNow(), RETRY_MS);
    return () => clearInterval(t);
  }, [waiting, syncNow]);

  return (
    <OutboxCtx.Provider value={{ entries, online, syncing, syncNow: () => void syncNow() }}>
      {children}
    </OutboxCtx.Provider>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line above every page: offline, and/or how much is waiting to be sent. */
export function SyncBanner() {
  const { entries, online, syncing, syncNow } = useOutbox();
  const failed = entries.filter((e) => e.error).length;
  const waiting = entries.length - failed;
  if (online && !entries.length) return null;
  const parts = [
    !online && "You're offline",
    waiting && `${plural(waiting, "entry", "entries")} waiting to sync`,
    failed && `${plural(failed, "entry", "entries")} couldn't be saved`,
  ].filter(Boolean);
  return (
    <div className={`sync-banner ${failed ? "error" : online ? "" : "offline"}`} role="status">
      <span>{parts.join(" · ") || "You're offline"}</span>
      {!online && !entries.length && <span className="muted">New entries will be saved on this device.</span>}
      {entries.length > 0 && (
        <span className="sync-actions">
          {waiting > 0 && (
            <button type="button" className="link small" disabled={syncing} onClick={syncNow}>
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          )}
          <Link className="link small" to="/add">
            Details
          </Link>
        </span>
      )}
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  date: "Date",
  amount: "Amount",
  category_id: "Category",
  property_id: "Property",
  vendor: "Paid to / by",
  subcategory: "Type",
  allocation: "Tax",
  description: "Note",
  account: "Account",
  needs_review: "Needs review",
  review_note: "Review note",
};

/** What a waiting entry does, in a few words. */
function describe(e: OutboxEntry) {
  if (e.op === "delete") return `Delete ${e.label}`;
  if (e.op === "attach") return `Receipts for ${e.label}`;
  if (e.op === "update") return `Changes to ${e.label}`;
  return e.label;
}

/** What's saved on this device and not yet on the server: edit what hasn't been sent, retry, resolve, discard. */
export function OutboxList() {
  const { entries, syncing, syncNow } = useOutbox();
  const { overview } = useSession();
  const toast = useToast();
  const [editing, setEditing] = useState<OutboxEntry | null>(null);
  // Sync skips an entry while it's open here, so it can't be sent half-edited.
  useEffect(() => {
    if (!editing) return;
    holdEntry(editing.id);
    return () => releaseEntry(editing.id);
  }, [editing]);
  if (!entries.length && !editing) return null;

  const show = (k: string, v: unknown) => {
    if (k === "amount") return money(Number(v));
    if (k === "category_id") return overview.categories.find((c) => c.id === v)?.name ?? String(v);
    if (k === "property_id") return overview.properties.find((p) => p.id === v)?.name ?? String(v);
    if (k === "date") return fmtDate(asText(v));
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return asText(v) || "—";
  };
  const close = () => setEditing(null);

  return (
    <section className="card" id="outbox">
      <h2>Saved on this device</h2>
      <p className="muted small">
        These go to the server the next time the app is open with a connection. Keep the app installed until they're
        sent.
      </p>
      <ul className="outbox-list">
        {entries.map((e) => {
          const fields = Object.keys(e.patch ?? {}).filter((k) => k in FIELD_LABELS);
          const canEdit = e.op === "create" && e.tx_id == null;
          return (
            <li key={e.id}>
              <div>
                <strong>{describe(e)}</strong>
                <small className="muted">
                  {" "}
                  {fmtDate(e.date)}
                  {e.files.length > 0 && ` · ${plural(e.files.length, "receipt")}`}
                  {e.op === "create" && e.tx_id != null && " · entry sent, receipts waiting"}
                  {e.op === "update" && fields.length > 0 && ` · ${fields.map((k) => FIELD_LABELS[k]).join(", ")}`}
                </small>
                {e.error && <div className="alert error small">{e.error}</div>}
                {e.conflict && e.patch && (
                  <table className="conflict">
                    <thead>
                      <tr>
                        <th />
                        <th>Yours</th>
                        <th>On the server now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map((k) => (
                        <tr key={k}>
                          <th>{FIELD_LABELS[k]}</th>
                          <td>{show(k, e.patch![k])}</td>
                          <td>{show(k, e.conflict![k as keyof Transaction])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <span className="outbox-actions">
                {canEdit && (
                  <button type="button" className="link small" disabled={syncing} onClick={() => setEditing(e)}>
                    Edit
                  </button>
                )}
                {e.conflict ? (
                  <button
                    type="button"
                    className="link small"
                    disabled={syncing}
                    title="Send your changes; other fields keep the server's values"
                    onClick={() => void keepMine(e.id).then(syncNow)}
                  >
                    Keep mine
                  </button>
                ) : (
                  e.error && (
                    <button
                      type="button"
                      className="link small"
                      onClick={() => void retryOutbox(e.id).then(syncNow)}
                      disabled={syncing}
                    >
                      Retry
                    </button>
                  )
                )}
                {e.conflict && (
                  <button
                    type="button"
                    className="link small"
                    disabled={syncing}
                    title={e.files.length ? "Drop your changes; your receipts still upload" : "Drop your changes"}
                    onClick={() => void keepTheirs(e.id).then(syncNow)}
                  >
                    Keep theirs
                  </button>
                )}
                <button
                  type="button"
                  className="link small danger"
                  onClick={() => {
                    const lost =
                      e.op === "create" && e.tx_id == null
                        ? "It hasn't been saved to the server."
                        : e.op === "create"
                          ? "The entry is saved; its receipts aren't."
                          : "The entry on the server stays as it is.";
                    if (confirm(`Discard "${describe(e)}"? ${lost}`)) void discardOutbox(e.id);
                  }}
                >
                  Discard
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn small" disabled={syncing} onClick={syncNow}>
        {syncing ? "Syncing…" : "Sync now"}
      </button>
      {editing && (
        <Modal title="Edit waiting entry" onClose={close} wide>
          <TxForm
            queued={editing}
            onSaved={close}
            onQueued={(text) => {
              toast({ text, kind: "ok" });
              close();
            }}
          />
        </Modal>
      )}
    </section>
  );
}
