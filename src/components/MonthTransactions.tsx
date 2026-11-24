import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, type Attachment, type MonthDetail } from "../api.ts";
import { fmtDate, money, money0, monthTitle } from "../format.ts";
import { useApi, usePersistentState, useSession, useToast } from "../hooks.ts";
import { AllocationBadge, Amount } from "../lib.tsx";
import {
  applyView,
  isNarrowed,
  showCount,
  txParts,
  type MonthView,
  type Tx,
  type TxLayout,
  type TxShow,
} from "../month-view.ts";

const CHIPS: { key: TxShow; label: string; optional?: boolean }[] = [
  { key: "all", label: "All" },
  { key: "income", label: "Income" },
  { key: "expense", label: "Expenses" },
  { key: "review", label: "Flagged", optional: true },
  { key: "receipt", label: "Needs receipt", optional: true },
];

interface RowCtx {
  canWrite: boolean;
  /** the month adds up several properties, so say which one each entry is in */
  showProperty: boolean;
  onOpen: (id: number) => void;
  onChanged: () => void;
}

export default function MonthTransactions({
  detail,
  items,
  ym,
  view,
  setView,
  showProperty,
  onOpen,
  onChanged,
}: {
  detail: MonthDetail;
  items: Tx[];
  ym: string;
  view: MonthView;
  setView: (patch: Partial<MonthView>) => void;
  showProperty: boolean;
  onOpen: (id: number) => void;
  onChanged: () => void;
}) {
  const { canWrite } = useSession();
  // how to lay the list out is a habit worth keeping on this device; the URL can still say otherwise
  const [saved, setSaved] = usePersistentState<TxLayout>("month-tx-view", "list");
  const layout = view.layout ?? saved;
  const [text, setText] = useState(view.q);
  const rows = applyView(items, view);
  const net = rows.reduce((sum, t) => sum + t.amount, 0);
  const narrowed = isNarrowed(view);
  const categories = [...new Map(items.map((t) => [t.category_id, t.category])).entries()].sort((a, b) =>
    a[1].localeCompare(b[1]),
  );
  const ctx: RowCtx = { canWrite, showProperty, onOpen, onChanged };
  const clear = () => {
    setText("");
    setView({ show: "all", q: "", cat: null });
  };

  return (
    <section className="card">
      <div className="section-head">
        <h2>Transactions</h2>
        {rows.length > 0 && (
          <span className="muted small">
            {rows.length} {rows.length === 1 ? "entry" : "entries"} · <Amount value={net} />
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="muted">Nothing recorded for {monthTitle(ym)}.</p>
      ) : (
        <>
          <div className="tx-toolbar">
            <div className="chips" role="group" aria-label="Show">
              {CHIPS.filter((c) => !c.optional || showCount(items, c.key) > 0 || view.show === c.key).map((c) => (
                <button
                  key={c.key}
                  className={`chip ${view.show === c.key ? "on" : ""}`}
                  aria-pressed={view.show === c.key}
                  onClick={() => setView({ show: c.key })}
                >
                  {c.label} <small>{showCount(items, c.key)}</small>
                </button>
              ))}
            </div>
            <div className="segmented small" role="group" aria-label="Layout">
              {(["list", "category"] as const).map((l) => (
                <button
                  key={l}
                  className={layout === l ? "on" : ""}
                  aria-pressed={layout === l}
                  onClick={() => {
                    setSaved(l);
                    setView({ layout: l });
                  }}
                >
                  {l === "list" ? "List" : "By category"}
                </button>
              ))}
            </div>
          </div>
          <div className="tx-tools">
            <input
              type="search"
              className="tx-search"
              placeholder="Search name, note or amount"
              aria-label="Search this month"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setView({ q: e.target.value });
              }}
            />
            {categories.length > 1 && (
              <select
                aria-label="Category"
                value={view.cat ?? ""}
                onChange={(e) => setView({ cat: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">All categories</option>
                {categories.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="btn small"
              onClick={() => setView({ sort: view.sort === "asc" ? "desc" : "asc" })}
              title="Order by date"
            >
              {view.sort === "asc" ? "Oldest first ↑" : "Newest first ↓"}
            </button>
            {narrowed && (
              <button className="link" onClick={clear}>
                Clear filters
              </button>
            )}
          </div>
          {rows.length === 0 ? (
            <p className="muted">Nothing matches.</p>
          ) : layout === "list" ? (
            <ul className="tx-mini tx-flat">
              {rows.map((t) => (
                <TxRow key={t.id} t={t} ctx={ctx} withCategory />
              ))}
            </ul>
          ) : (
            <CategoryGroups detail={detail} rows={rows} whole={!narrowed} ctx={ctx} />
          )}
        </>
      )}
    </section>
  );
}

function TxLabel({ t }: { t: Tx }) {
  const { main, rest } = txParts(t);
  return (
    <>
      {main}
      {rest.map((r) => (
        <small key={r}> · {r}</small>
      ))}
      {t.needs_review && <small className="tx-note">⚑ {t.review_note || "Flagged for review"}</small>}
    </>
  );
}

function TxRow({ t, ctx, withCategory }: { t: Tx; ctx: RowCtx; withCategory?: boolean }) {
  const { hasName } = txParts(t);
  // the category column says nothing new when the entry has no name of its own (the name already is the category)
  const where = [withCategory && hasName ? t.category : null, ctx.showProperty ? t.property : null].filter(Boolean);
  return (
    <li className="tx-row">
      <button className="row-btn" onClick={() => ctx.onOpen(t.id)}>
        <span>{fmtDate(t.date)}</span>
        <span>
          <TxLabel t={t} />
          {where.length > 0 &&
            (withCategory ? (
              <small className="tx-cat-inline muted">{where.join(" · ")}</small>
            ) : (
              <small> · {where.join(" · ")}</small>
            ))}
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
      <RowActions t={t} ctx={ctx} />
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
              <a className="link small" href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer">
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
        accept="image/*,application/pdf"
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

function CategoryGroups({
  detail,
  rows,
  whole,
  ctx,
}: {
  detail: MonthDetail;
  rows: Tx[];
  /** the rows are the whole month, so the month's own 12-month averages apply */
  whole: boolean;
  ctx: RowCtx;
}) {
  const byCat = new Map(detail.by_category.map((c) => [c.category_id, c]));
  const order = detail.by_category.map((c) => c.category_id);
  return (
    <div className="cat-groups">
      {(["income", "expense"] as const).map((kind) => {
        const kindRows = rows.filter((t) => t.kind === kind);
        if (!kindRows.length) return null;
        // the month's own category order first, then anything it doesn't know
        const ids = [...new Set(kindRows.map((t) => t.category_id))].sort(
          (a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9),
        );
        const total = kindRows.reduce((sum, t) => sum + t.amount, 0);
        return (
          <div key={kind}>
            <h3 className="group-title">
              {kind === "income" ? "Income" : "Expenses"}
              <span>{money(total)}</span>
            </h3>
            {ids.map((id) => {
              const g = byCat.get(id);
              const catRows = kindRows.filter((t) => t.category_id === id);
              const amount = catRows.reduce((sum, t) => sum + t.amount, 0);
              const vsAvg = g ? Math.abs(amount) - Math.abs(g.avg_12) : 0;
              return (
                <details key={id} className="cat-group" open>
                  <summary>
                    <span className="cat-name">
                      {catRows[0]!.category} <small className="muted">({catRows.length})</small>
                    </span>
                    <span className="cat-compare muted small">
                      {whole && g && (
                        <>
                          avg {money0(Math.abs(g.avg_12))}
                          {Math.abs(g.avg_12) > 0 && Math.abs(vsAvg) >= 1 && (
                            <span className={`delta ${vsAvg > 0 === (kind === "income") ? "good" : "bad"}`}>
                              {" "}
                              {vsAvg > 0 ? "▲" : "▼"} {money0(Math.abs(vsAvg))}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                    <Amount value={amount} />
                  </summary>
                  <ul className="tx-mini">
                    {catRows.map((t) => (
                      <TxRow key={t.id} t={t} ctx={ctx} />
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
