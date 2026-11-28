import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { apiUrl } from "../portfolio.ts";
import { api, type Attachment } from "../api.ts";
import { fmtDate } from "../format.ts";
import { useApi, useSession, useToast, type TxSelection } from "../hooks.ts";
import { AllocationBadge, Amount } from "../lib.tsx";
import { txParts, type Tx } from "../month-view.ts";

/**
 * One entry as a list row, shared by the Month page and the Transactions page: date, name (with its memo and flag
 * note), category, tax treatment and amount, then flag / receipt icons that each open a small popover. On a narrow
 * screen the name and amount share the first line and the date and category go on one line under the name.
 */
export interface RowCtx {
  canWrite: boolean;
  /** the list adds up several properties, so say which one each entry is in */
  showProperty: boolean;
  onOpen: (id: number) => void;
  onChanged: () => void;
  /** changes saved offline and not yet synced, by entry (the row still shows the server's copy until then) */
  pending?: Map<number, string>;
  /** false = a picker: tapping the row is the whole action, with no flag/receipt buttons */
  actions?: boolean;
  /** dropping files on a row attaches them (the Files page's "Needs a receipt" list) */
  onDropFiles?: (t: Tx, files: File[]) => void;
  /** select mode: a checkbox per row, and tapping the row toggles it instead of opening the entry */
  select?: { selected: Set<number>; toggle: (id: number) => void };
}

const PENDING_TEXT: Record<string, string> = {
  delete: "Delete waiting to sync",
  attach: "Receipt waiting to sync",
};

function TxLabel({ t }: { t: Tx }) {
  const { main, rest } = txParts(t);
  return (
    <>
      {main}
      {rest.map((r) => (
        <small key={r} className="tx-sub">
          {r}
        </small>
      ))}
      {t.needs_review && <small className="tx-note">⚑ {t.review_note || "Flagged for review"}</small>}
    </>
  );
}

export function TxRow({
  t,
  ctx,
  withCategory,
  note,
}: {
  t: Tx;
  ctx: RowCtx;
  withCategory?: boolean;
  /** a short extra, e.g. where the change came from: after the name, or on the date line on a phone */
  note?: string;
}) {
  const { hasName } = txParts(t);
  // the category column says nothing new when the entry has no name of its own (the name already is the category)
  const where = [withCategory && hasName ? t.category : null, ctx.showProperty ? t.property : null].filter(Boolean);
  const pending = ctx.pending?.get(t.id);
  const selected = ctx.select?.selected.has(t.id) ?? false;
  const [over, setOver] = useState(false);
  const drop = ctx.onDropFiles
    ? {
        onDragOver: (e: DragEvent) => {
          e.preventDefault();
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) ctx.onDropFiles!(t, [...e.dataTransfer.files]);
        },
      }
    : {};
  const cls = [
    "tx-row",
    ctx.select && "selectable",
    selected && "selected",
    ctx.actions === false && "no-actions",
    over && "drop-over",
  ].filter(Boolean);
  return (
    <li className={cls.join(" ")} {...drop}>
      {ctx.select && (
        <span className="tx-check">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => ctx.select!.toggle(t.id)}
            aria-label={`Select #${t.id}`}
          />
        </span>
      )}
      <button className="row-btn" onClick={() => (ctx.select ? ctx.select.toggle(t.id) : ctx.onOpen(t.id))}>
        <span className="tx-date">{fmtDate(t.date)}</span>
        <span className="tx-name">
          <TxLabel t={t} />
          {where.length > 0 && !withCategory && <small className="tx-where"> · {where.join(" · ")}</small>}
          {note && <small className="tx-where"> · {note}</small>}
          {pending && (
            <small className="tx-pending" title="Saved on this device; syncs when you're back online">
              {PENDING_TEXT[pending] ?? "Changes waiting to sync"}
            </small>
          )}
          {/* a narrow screen has no date or category column: both go on one line under the name */}
          <small className="tx-meta">{[fmtDate(t.date), ...where, note].filter(Boolean).join(" · ")}</small>
        </span>
        {withCategory && (
          <span className="tx-cat muted small">
            {hasName && <span>{t.category}</span>}
            {ctx.showProperty && <small>{t.property}</small>}
          </span>
        )}
        <AllocationBadge value={t.allocation} />
        <Amount value={t.amount} />
      </button>
      {ctx.actions !== false && <RowActions t={t} ctx={ctx} />}
    </li>
  );
}
const Clip = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path
      d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.4-2.4l8.3-8.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * An entry's flag and receipt as two icons (amber = needs attention, green = receipt attached, faint = nothing yet).
 * Each opens a small popover that shows what's there and offers the action (receipts: the files and "add"; flag: the
 * reason, with a way to change or clear it).
 */
function RowActions({ t, ctx }: { t: Tx; ctx: RowCtx }) {
  const [open, setOpen] = useState<"receipt" | "flag" | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const receipts = t.attachment_count;
  const receiptClass = t.needs_receipt ? "need" : receipts ? "has" : "idle";
  const receiptLabel = t.needs_receipt
    ? "Needs a receipt"
    : receipts
      ? `${receipts} ${receipts === 1 ? "receipt" : "receipts"} attached`
      : "Add a receipt";
  const clip = (
    <>
      <Clip />
      {receipts > 0 && <small>{receipts}</small>}
    </>
  );

  if (!ctx.canWrite) {
    return (
      <span className="row-actions">
        {(t.needs_receipt || receipts > 0) && (
          <span className={`act-btn ${receiptClass}`} title={receiptLabel}>
            {clip}
          </span>
        )}
      </span>
    );
  }
  const icon = (kind: "receipt" | "flag", cls: string, label: string, content: ReactNode) => (
    <button
      className={`act-btn ${cls} ${open === kind ? "open" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open === kind}
      aria-label={label}
      title={label}
      onClick={() => setOpen(open === kind ? null : kind)}
    >
      {content}
    </button>
  );
  const flagLabel = t.needs_review
    ? `Flagged for review${t.review_note ? `: ${t.review_note}` : ""}`
    : "Flag for review";
  return (
    <span className="row-actions" ref={box}>
      {icon("flag", t.needs_review ? "flagged" : "idle", flagLabel, "⚑")}
      {icon("receipt", receiptClass, receiptLabel, clip)}
      {open === "receipt" && <ReceiptPop t={t} ctx={ctx} onDone={() => setOpen(null)} />}
      {open === "flag" && <FlagPop t={t} ctx={ctx} onDone={() => setOpen(null)} />}
    </span>
  );
}

/** Runs a change from a popover: busy state, a toast, a reload. */
function useRowChange(ctx: RowCtx, onDone: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>, done: string, action?: { label: string; run: () => void }) => {
    setBusy(true);
    try {
      await work();
      toast({ text: done, kind: "ok", action });
      ctx.onChanged();
      onDone();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
      setBusy(false);
    }
  };
  return { busy, run };
}

function ReceiptPop({ t, ctx, onDone }: { t: Tx; ctx: RowCtx; onDone: () => void }) {
  const files = useApi<Attachment[]>(`transactions/${t.id}/attachments`);
  const { busy, run } = useRowChange(ctx, onDone);
  const input = useRef<HTMLInputElement>(null);
  const attach = (picked: FileList | null) => {
    if (!picked?.length) return;
    const form = new FormData();
    for (const f of picked) form.append("file", f);
    void run(() => api(`transactions/${t.id}/attachments`, { method: "POST", body: form }), "Receipt attached");
  };
  return (
    <div className="row-pop" role="dialog" aria-label="Receipts">
      {files.error ? (
        <p className="muted small">{files.error}</p>
      ) : !files.data ? (
        <p className="muted small">Loading…</p>
      ) : files.data.length === 0 ? (
        <p className="small">
          {t.needs_receipt ? "This expense needs a receipt and has none." : "No receipt attached."}
        </p>
      ) : (
        <ul className="pop-files">
          {files.data.map((f) => (
            <li key={f.id}>
              <span title={f.filename}>{f.filename}</span>
              <a className="link small" href={apiUrl(`/api/attachments/${f.id}`)} target="_blank" rel="noreferrer">
                View
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="pop-actions">
        <button className="btn small" disabled={busy} onClick={() => input.current?.click()}>
          {files.data?.length ? "Add another…" : "Choose file…"}
        </button>
        <button className="link small" onClick={() => ctx.onOpen(t.id)}>
          Open entry
        </button>
      </div>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept="image/*,application/pdf,text/plain,text/csv,.heic,.heif"
        onChange={(e) => {
          attach(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function FlagPop({ t, ctx, onDone }: { t: Tx; ctx: RowCtx; onDone: () => void }) {
  const { busy, run } = useRowChange(ctx, onDone);
  const [note, setNote] = useState(t.review_note);
  const patch = (json: Record<string, unknown>) =>
    api(`transactions/${t.id}`, { method: "PATCH", json: { ...json, expected_updated_at: t.updated_at } });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = note.trim();
    if (!t.needs_review) void run(() => patch({ needs_review: true, review_note: text }), "Flagged for review");
    else if (text !== t.review_note) void run(() => patch({ review_note: text }), "Note saved");
    else onDone();
  };
  return (
    <form className="row-pop" role="dialog" aria-label="Flag for review" onSubmit={submit}>
      <label className="small">
        {t.needs_review ? "Why it's flagged" : "Why flag it? (optional)"}
        <input
          autoFocus
          value={note}
          maxLength={2000}
          placeholder="e.g. check the amount against the statement"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="pop-actions">
        <button className="btn small primary" disabled={busy}>
          {t.needs_review ? "Save note" : "Flag"}
        </button>
        {t.needs_review && (
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={() =>
              void run(() => patch({ needs_review: false }), "Flag cleared", {
                // clearing a flag also clears its note, so offer to put both back
                label: "Undo",
                run: () =>
                  void api(`transactions/${t.id}`, {
                    method: "PATCH",
                    json: { needs_review: true, review_note: t.review_note },
                  }).then(ctx.onChanged),
              })
            }
          >
            Clear flag
          </button>
        )}
      </div>
    </form>
  );
}

/** The "Select" / "Done" button that turns select mode on and off. */
export function SelectToggle({ sel }: { sel: TxSelection }) {
  const { canWrite } = useSession();
  if (!canWrite) return null;
  return (
    <button
      className={`btn small ${sel.on ? "primary" : ""}`}
      aria-pressed={sel.on}
      onClick={() => (sel.on ? sel.stop() : sel.start())}
    >
      {sel.on ? "Done" : "Select"}
    </button>
  );
}

/**
 * Changes for the selected entries (category, tax treatment, reviewed, delete). Acts only on the ticked entries that
 * are on screen (`ids`), so a filter that hides a ticked row also leaves it alone.
 */
export function BulkBar({ sel, ids, onChanged }: { sel: TxSelection; ids: number[]; onChanged: () => void }) {
  const { overview } = useSession();
  const toast = useToast();
  if (!sel.on) return null;
  const chosen = ids.filter((id) => sel.selected.has(id));
  const all = ids.length > 0 && chosen.length === ids.length;
  const bulk = async (patch: Record<string, unknown>, label: string) => {
    try {
      await api("transactions/bulk-update", { method: "POST", json: { ids: chosen, patch } });
      toast({ text: `${label}: ${chosen.length} updated`, kind: "ok" });
      onChanged();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  // no question first: deleted entries go to the trash, and Undo brings them back (like deleting one entry)
  const remove = async () => {
    const ids = chosen;
    try {
      await api("transactions/bulk-delete", { method: "POST", json: { ids } });
      toast({
        text: `${ids.length} ${ids.length === 1 ? "entry" : "entries"} deleted`,
        kind: "ok",
        action: {
          label: "Undo",
          run: () =>
            void Promise.all(ids.map((id) => api(`transactions/${id}/restore`, { method: "POST" }))).then(
              onChanged,
              (e: Error) => toast({ text: e.message, kind: "error" }),
            ),
        },
      });
      sel.setSelected(new Set());
      onChanged();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  return (
    <div className="bulk-bar tx-bulk">
      <label className="check">
        <input type="checkbox" checked={all} onChange={() => sel.setSelected(all ? new Set() : new Set(ids))} />
        <strong>{chosen.length ? `${chosen.length} selected` : "Select all"}</strong>
      </label>
      {chosen.length > 0 && (
        <>
          <select
            defaultValue=""
            onChange={(e) =>
              e.target.value &&
              void bulk({ category_id: Number(e.target.value) }, "Category changed").then(() => (e.target.value = ""))
            }
            aria-label="Set category"
          >
            <option value="">Set category…</option>
            {overview.categories
              .filter((c) => !c.archived)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <button className="btn small" onClick={() => void bulk({ allocation: "direct" }, "Marked direct")}>
            Direct
          </button>
          <button className="btn small" onClick={() => void bulk({ allocation: "indirect" }, "Marked indirect")}>
            Indirect
          </button>
          <button className="btn small" onClick={() => void bulk({ needs_review: false }, "Reviewed")}>
            Mark reviewed
          </button>
          <button className="btn small danger-outline" onClick={() => void remove()}>
            Delete
          </button>
        </>
      )}
    </div>
  );
}
