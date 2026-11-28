import { useState, type FormEvent } from "react";
import { apiUrl } from "../portfolio.ts";
import { Link, useSearchParams } from "react-router";
import { api, qs, type FileLibrary, type LibraryFile, type Transaction, type TxList } from "../api.ts";
import { MonthNav } from "../components/MonthPicker.tsx";
import TxEditModal from "../components/TxEditModal.tsx";
import { TxRow, type RowCtx } from "../components/TxRows.tsx";
import { txParts } from "../month-view.ts";
import { fmtDate, money, monthTitle, thisMonth, THIS_YEAR } from "../format.ts";
import {
  useApi,
  usePendingByEntry,
  usePersistentState,
  useSession,
  useToast,
  useProperty,
  useScopedPath,
} from "../hooks.ts";
import { uploadOrQueue } from "../outbox.ts";
import { Amount, Modal, YearSelect } from "../lib.tsx";

const size = (b: number) =>
  b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
/** Browsers other than Safari can't draw HEIC, so those get an icon like any other document. */
const isImage = (f: { content_type: string }) => /^image\/(jpeg|png|webp|gif)$/.test(f.content_type);
const typeLabel = (f: LibraryFile) =>
  f.content_type === "application/pdf"
    ? "PDF"
    : f.content_type === "text/csv"
      ? "CSV"
      : f.content_type.startsWith("image/")
        ? f.content_type.slice(6).toUpperCase()
        : "TXT";
/** an entry's name, the same way the transaction lists name it */
const entryLabel = (t: { vendor: string; subcategory: string; description: string; category: string }) =>
  txParts(t).main;

export default function Files() {
  const { path: scoped, key: property } = useProperty();
  const { canWrite, user } = useSession();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const year = params.get("year");
  const month = year ? null : (params.get("month") ?? thisMonth());
  const q = params.get("q") ?? "";
  const source = params.get("source") ?? "all";
  const filters = { month, year, q: q.trim(), source: source === "all" ? "" : source, property_id: property };
  const lib = useApi<FileLibrary>(`files${qs(filters)}`);
  const [editing, setEditing] = useState<number | null>(null);
  const [viewing, setViewing] = useState<LibraryFile | null>(null);
  // Collapsed unless opened before (remembered) or linked with ?missing=1 (from To do).
  const [showMissing, setShowMissing] = usePersistentState("files.showMissing", false);
  const missingOpen = showMissing || params.get("missing") === "1";
  const [linking, setLinking] = useState<LibraryFile | null>(null);

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const go = (p: { month?: string; year?: string }) => set({ month: p.month ?? null, year: p.year ?? null });
  /** this page for another month, keeping the search and source */
  const monthPath = (m: string) => {
    const next = new URLSearchParams(params);
    next.set("month", m);
    next.delete("year");
    return scoped(`/files?${next}`);
  };
  const reload = () => void lib.reload();

  const upload = async (tx: Transaction, files: File[]) => {
    if (!files.length) return;
    try {
      const label = `${entryLabel(tx)} · ${money(tx.amount)}`;
      const what = files.length === 1 ? files[0]!.name : `${files.length} files`;
      if ((await uploadOrQueue(user.id, { id: tx.id, date: tx.date, label }, files)) === "queued") {
        toast({ text: `No connection: ${what} kept on this device; it uploads when you reconnect`, kind: "ok" });
        return;
      }
      toast({ text: `Attached ${what}`, kind: "ok" });
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };

  // the expenses still missing a receipt, as entry rows: tap opens the entry, the paperclip or a dropped file attaches
  const missingCtx: RowCtx = {
    canWrite,
    showProperty: property === "all",
    onOpen: setEditing,
    onChanged: reload,
    pending: usePendingByEntry(),
    onDropFiles: canWrite ? (t, files) => void upload(t, files) : undefined,
  };

  const rename = async (f: LibraryFile, name: string) => {
    if (!name || name === f.filename) return;
    try {
      // Every entry holding this file shows the same name.
      for (const l of f.links)
        await api(`attachments/${l.attachment_id}`, { method: "PATCH", json: { filename: name } });
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };

  /** No question asked: deleting the file's last copy is confirmed in the row, anything else can be undone. */
  const unlink = async (f: LibraryFile, attachmentId: number) => {
    const link = f.links.find((l) => l.attachment_id === attachmentId)!;
    const where = `${entryLabel(link)} (${fmtDate(link.date)})`;
    const deletes = f.links.length === 1 && f.other_uses === 0;
    // Undo re-links the file from an entry that still has it.
    const keep = f.links.find((l) => l.attachment_id !== attachmentId);
    try {
      await api(`attachments/${attachmentId}`, { method: "DELETE" });
      toast({
        text: deletes ? `Deleted ${f.filename}` : `Unlinked ${f.filename} from ${where}`,
        kind: "ok",
        action: keep
          ? {
              label: "Undo",
              run: () =>
                void api(`attachments/${keep.attachment_id}/link`, {
                  method: "POST",
                  json: { transaction_id: link.transaction_id },
                }).then(reload, (e: Error) => toast({ text: e.message, kind: "error" })),
            }
          : undefined,
      });
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };

  const d = lib.data;
  const groups = new Map<string, LibraryFile[]>();
  for (const f of d?.files ?? []) groups.set(f.month, [...(groups.get(f.month) ?? []), f]);
  const zipHref = apiUrl(`/api/files.zip${qs(filters)}`);
  const y = year ?? month!.slice(0, 4);

  return (
    <div className="page">
      <header className="page-head">
        {month ? <MonthNav ym={month} to={monthPath} /> : <h1>Files</h1>}
        <div className="head-actions">
          {/* a year is picked the way it is everywhere else: the year menu */}
          {year && <YearSelect value={Number(year)} onChange={(v) => go({ year: String(v) })} />}
          <div className="segmented" role="group" aria-label="Period">
            <button
              className={month ? "on" : ""}
              onClick={() => go({ month: y === String(THIS_YEAR) ? thisMonth() : `${y}-12` })}
            >
              Month
            </button>
            <button className={year ? "on" : ""} onClick={() => go({ year: y })}>
              Year
            </button>
          </div>
          {d && d.files.length > 0 && (
            <a className="btn" href={zipHref} download>
              Download all
            </a>
          )}
        </div>
      </header>

      <div className="tx-tools">
        <input
          type="search"
          className="tx-search"
          placeholder="Search files, vendors, categories"
          defaultValue={q}
          onChange={(e) => set({ q: e.target.value })}
          aria-label="Search"
        />
        <select value={source} onChange={(e) => set({ source: e.target.value === "all" ? null : e.target.value })}>
          <option value="all">All files</option>
          <option value="receipts">Receipts</option>
          <option value="manager">Manager paperwork</option>
        </select>
      </div>

      {lib.error && <div className="alert error">{lib.error}</div>}

      {d && (
        <p className="muted small files-summary">
          {d.totals.files === 0
            ? "No files"
            : `${d.totals.files} ${d.totals.files === 1 ? "file" : "files"} · ${size(d.totals.bytes)}`}
          {d.totals.manager > 0 && ` · ${d.totals.manager} from the manager`}
          {month && (
            <>
              {" · "}
              <Link to={scoped(`/months/${month}`)}>{monthTitle(month)} entries</Link>
            </>
          )}
        </p>
      )}

      {d && d.missing.length > 0 && (
        <section className="card">
          <button
            className="section-toggle"
            onClick={() => {
              setShowMissing(!missingOpen);
              if (params.has("missing")) set({ missing: null });
            }}
            aria-expanded={missingOpen}
            aria-controls="needs-receipt"
          >
            <span className="fold-title">
              <span className="fold-mark" aria-hidden="true">
                {missingOpen ? "▾" : "▸"}
              </span>
              Needs a receipt <span className="muted small">optional</span>
            </span>
            <span className="muted small">
              {d.missing_total} {d.missing_total === 1 ? "expense" : "expenses"} without one
            </span>
          </button>
          {missingOpen && (
            <div id="needs-receipt">
              <p className="muted small">
                Not required, but handy if your preparer asks. Expenses of {money(d.receipt_min).replace(/\.00$/, "")}+
                by default; <Link to="/settings/categories">choose per category or vendor</Link>.
                {canWrite && " Drop a file on a row, or tap its paperclip."}
              </p>
              <ul className="tx-mini tx-flat">
                {d.missing.map((t) => (
                  <TxRow key={t.id} t={t} ctx={missingCtx} withCategory />
                ))}
              </ul>
              {d.missing_total > d.missing.length && (
                <p className="muted small">
                  Showing the first {d.missing.length}.{" "}
                  <Link
                    to={scoped(
                      `/transactions${qs({
                        year: month ? undefined : y,
                        month: month ?? undefined,
                        needs_receipt: "true",
                        property_id: property,
                      })}`,
                    )}
                  >
                    See all
                  </Link>
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {d && (
        <section className="card">
          {d.files.length === 0 ? (
            <p className="empty">
              {q || source !== "all"
                ? "No files match."
                : `No files for ${month ? monthTitle(month) : year} yet. Attach receipts to entries, or upload manager paperwork on the Manager page.`}
            </p>
          ) : (
            [...groups].map(([m, files]) => (
              <div key={m} className="file-group">
                {!month && (
                  <h3 className="group-title">
                    <button className="link" onClick={() => go({ month: m })}>
                      {monthTitle(m)}
                    </button>
                    <span className="muted small">{files.length}</span>
                  </h3>
                )}
                <ul className="file-list">
                  {files.map((f) => (
                    <FileRow
                      key={f.key}
                      file={f}
                      canWrite={canWrite}
                      onView={() => (isImage(f) ? setViewing(f) : window.open(apiUrl(f.url), "_blank", "noopener"))}
                      onOpenEntry={setEditing}
                      onRename={(name) => rename(f, name)}
                      onLink={() => setLinking(f)}
                      onUnlink={(attachmentId) => void unlink(f, attachmentId)}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      )}

      {viewing && (
        <Modal title={viewing.filename} onClose={() => setViewing(null)} wide>
          <img className="file-preview" src={apiUrl(viewing.url)} alt={viewing.filename} />
          <div className="form-actions">
            <a className="btn" href={apiUrl(viewing.url)} target="_blank" rel="noreferrer">
              Open in new tab
            </a>
            <a className="btn" href={apiUrl(`${viewing.url}?download`)}>
              Download
            </a>
          </div>
        </Modal>
      )}
      {linking && (
        <LinkDialog
          file={linking}
          onClose={() => setLinking(null)}
          onDone={() => {
            setLinking(null);
            reload();
          }}
        />
      )}
      {editing && <TxEditModal id={editing} onClose={() => setEditing(null)} onChanged={reload} />}
    </div>
  );
}

function FileRow({
  file: f,
  canWrite,
  onView,
  onOpenEntry,
  onRename,
  onLink,
  onUnlink,
}: {
  file: LibraryFile;
  canWrite: boolean;
  onView: () => void;
  onOpenEntry: (id: number) => void;
  onRename: (name: string) => Promise<void>;
  onLink: () => void;
  onUnlink: (attachmentId: number) => void;
}) {
  const scoped = useScopedPath();
  // Manager paperwork is linked and unlinked from the Manager page, not here.
  const editable = canWrite && !f.manager;
  /** Unlinking this entry would delete the file: ask in the row first. */
  const [confirming, setConfirming] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(f.filename);
  const deletes = f.links.length === 1 && f.other_uses === 0;
  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    await onRename(draft.trim());
    setRenaming(false);
  };
  return (
    <li className="file-row">
      <button className="file-thumb" onClick={onView} aria-label={`View ${f.filename}`}>
        {isImage(f) || f.preview_url ? (
          <img src={apiUrl(isImage(f) ? f.url : f.preview_url!)} alt="" loading="lazy" />
        ) : (
          <span>{typeLabel(f)}</span>
        )}
      </button>
      <div className="file-main">
        {renaming ? (
          <form className="inline-form file-rename" onSubmit={(e) => void saveName(e)}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
              aria-label="File name"
              autoFocus
              onFocus={(e) => {
                // Select the name without its extension, like a file manager does.
                const dot = e.target.value.lastIndexOf(".");
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
              }}
            />
            <button className="btn small primary">Save</button>
            <button type="button" className="btn small ghost" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button className="link file-name" onClick={onView} title={f.filename}>
            {f.filename}
          </button>
        )}
        <span className="muted small">
          {f.manager && (
            <span className="badge">
              Manager {f.manager.kind}
              {f.manager.reference && ` #${f.manager.reference}`}
            </span>
          )}{" "}
          {size(f.size)} · added {fmtDate(f.uploaded_at.slice(0, 10))}
        </span>
        {f.links.length > 0 ? (
          <ul className="file-links">
            {f.links.map((l) => (
              <li key={l.attachment_id}>
                <button className="link" onClick={() => onOpenEntry(l.transaction_id)}>
                  {fmtDate(l.date).replace(/, \d{4}$/, "")} · {entryLabel(l)}
                </button>{" "}
                <Amount value={l.amount} />
                {editable &&
                  (confirming === l.attachment_id ? (
                    <span className="file-confirm" role="group" aria-label="Confirm delete">
                      <span>This is the only entry with this file, so unlinking deletes it.</span>
                      <button className="btn small danger-outline" onClick={() => onUnlink(l.attachment_id)}>
                        Delete file
                      </button>
                      <button className="btn small ghost" onClick={() => setConfirming(null)} autoFocus>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      className="link danger small"
                      onClick={() => (deletes ? setConfirming(l.attachment_id) : onUnlink(l.attachment_id))}
                    >
                      unlink
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted small">No entries in this period</span>
        )}
      </div>
      <div className="file-actions">
        <a className="btn small" href={apiUrl(`${f.url}?download`)}>
          Download
        </a>
        {f.manager && (
          <Link className="btn small ghost" to={scoped(`/statement/${f.manager.month}`)}>
            Manager page
          </Link>
        )}
        {editable && f.links.length > 0 && (
          <button
            className="btn small ghost"
            onClick={() => {
              setDraft(f.filename);
              setRenaming(true);
            }}
          >
            Rename
          </button>
        )}
        {editable && f.links.length > 0 && (
          <button className="btn small ghost" onClick={onLink}>
            Link to entry…
          </button>
        )}
      </div>
    </li>
  );
}

/** Attach a file to another entry as well. It stays on the entries it's already on. */
function LinkDialog({ file, onClose, onDone }: { file: LibraryFile; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { key: property } = useProperty();
  const first = file.links[0]!;
  const linked = new Set(file.links.map((l) => l.transaction_id));
  const [q, setQ] = useState("");
  const [anyDate, setAnyDate] = useState(false);
  const list = useApi<TxList>(
    `transactions${qs({
      q: q.trim(),
      month: anyDate ? undefined : first.date.slice(0, 7),
      limit: 50,
      sort: "date_asc",
      property_id: property,
    })}`,
  );
  const link = async (t: Transaction) => {
    try {
      await api(`attachments/${first.attachment_id}/link`, { method: "POST", json: { transaction_id: t.id } });
      toast({ text: `Linked to ${entryLabel(t)} (${fmtDate(t.date)})`, kind: "ok" });
      onDone();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  // tapping a row links the file; no flag/receipt buttons in a picker
  const pick: RowCtx = {
    canWrite: false,
    showProperty: false,
    actions: false,
    onOpen: (id) => {
      const t = list.data?.items.find((x) => x.id === id);
      if (t) void link(t);
    },
    onChanged: () => {},
  };
  return (
    <Modal title={`Link ${file.filename}`} onClose={onClose}>
      <p className="muted small">
        Pick another entry to attach this file to. It stays on the {file.links.length === 1 ? "entry" : "entries"} it's
        already on; unlink those separately if it was on the wrong one.
      </p>
      <div className="tx-tools">
        <input
          type="search"
          className="tx-search"
          placeholder="Search name, note or amount"
          aria-label="Search entries"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <label className="check">
          <input type="checkbox" checked={anyDate} onChange={(e) => setAnyDate(e.target.checked)} /> Any month
        </label>
      </div>
      <ul className="tx-mini tx-flat">
        {list.data?.items
          .filter((t) => !linked.has(t.id))
          .map((t) => (
            <TxRow key={t.id} t={t} ctx={pick} withCategory />
          ))}
      </ul>
      {list.data && list.data.items.every((t) => linked.has(t.id)) && <p className="muted">No entries found.</p>}
    </Modal>
  );
}
