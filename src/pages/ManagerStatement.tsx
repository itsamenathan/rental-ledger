import { useEffect, useState, type DragEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api.ts";
import { fmtDate, money, monthTitle, shiftMonth, thisMonth } from "../format.ts";
import { useApi, usePersistentState, useSession, useToast } from "../hooks.ts";
import TxEditModal from "../components/TxEditModal.tsx";

// ---------------- types ----------------

interface Doc {
  id: number;
  month: string;
  kind: "statement" | "invoice";
  filename: string;
  content_type: string;
  size: number;
  reference: string;
  created_at: string;
}
interface MonthRow {
  month: string;
  statement: Doc | null;
  invoices: Doc[];
  status: "empty" | "done" | "todo" | "check" | "error";
  to_add: number;
  to_check: number;
  payouts: number;
  invoice_total: number;
  error?: string;
}
interface SaveResult {
  filename: string;
  status: "saved" | "replaced" | "duplicate" | "conflict" | "error";
  message: string;
  document?: Doc;
}
interface IncomeRow {
  reservation_id: string;
  channel: string;
  check_in: string;
  check_out: string;
  nights: number;
  payout: number;
  status: "matched" | "differs" | "missing" | "batched";
  transaction_date?: string;
  transactions?: { id: number; date: string; amount: number }[];
  difference?: number;
}
interface Line {
  key: string;
  item: string;
  description: string;
  amount: number;
  invoice: string;
  category: string | null;
  category_id: number | null;
  status: "exists" | "missing" | "uncategorized";
  ledger_category?: string;
  transaction_id?: number;
  date: string;
}
interface Check {
  level: "ok" | "warn" | "info";
  text: string;
  code?: "income" | "lines";
  key?: string;
  explained?: { note: string; at: string };
}
interface Review {
  month: string;
  subcategory: string;
  documents: Doc[];
  invoices: { number: string; paid: string | null; total: number | null; document_id: number | null }[];
  income: IncomeRow[];
  unlisted_income: { id: number; date: string; amount: number }[];
  lines: Line[];
  checks: Check[];
  categories: { id: number; name: string }[];
}
interface Applied {
  tagged: number[];
  created_income: number[];
  created_expenses: number[];
  attachments: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const channelName = (c: string) =>
  /vrbo|homeaway/i.test(c) ? "VRBO" : /booking ?engine/i.test(c) ? "Direct booking" : /airbnb/i.test(c) ? "Airbnb" : c;
const fileUrl = (d: Doc) => `/api/manager/documents/${d.id}/file`;
const docLabel = (d: Doc) =>
  d.kind === "statement" ? "Owner statement" : `Invoice${d.reference ? ` #${d.reference}` : ""}`;

/** The property the page works on (only matters with more than one), shared by both views. */
function useProperty() {
  const { overview } = useSession();
  const active = overview.properties.filter((p) => !p.archived);
  const [id, setId] = usePersistentState("ms-property", active[0]?.id ?? 0);
  const valid = active.some((p) => p.id === id) ? id : (active[0]?.id ?? 0);
  return { id: valid, setId, many: active.length > 1, active, qs: active.length > 1 ? `property_id=${valid}` : "" };
}

const STATUS: Record<MonthRow["status"], { badge: string; text: (m: MonthRow) => string }> = {
  empty: { badge: "muted", text: () => "Nothing saved" },
  done: { badge: "ok", text: () => "All recorded" },
  todo: { badge: "warn", text: (m) => `${plural(m.to_add, "entry", "entries")} to add` },
  check: { badge: "warn", text: (m) => `${plural(m.to_check, "thing")} to check` },
  error: { badge: "err", text: () => "Can't read" },
};

// ---------------- upload ----------------

/** Drop zone + file picker that saves files and reports what happened to each. */
function Upload({ month, onSaved }: { month?: string; onSaved: () => void }) {
  const toast = useToast();
  const property = useProperty();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [results, setResults] = useState<(SaveResult & { file: File })[]>([]);

  const send = async (files: File[], replace = false) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of files) form.append("file", f);
      if (replace) form.append("replace", "true");
      if (month) form.append("month", month);
      const res = await api<SaveResult[]>(`manager/documents${property.qs ? `?${property.qs}` : ""}`, {
        method: "POST",
        body: form,
      });
      const byName = new Map(files.map((f) => [f.name, f]));
      setResults((prev) => [
        ...prev.filter((p) => !res.some((r) => r.filename === p.filename)),
        ...res.map((r) => ({ ...r, file: byName.get(r.filename)! })),
      ]);
      onSaved();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void send([...e.dataTransfer.files]);
  };

  return (
    <div>
      <label
        className={`ms-drop${over ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          multiple
          accept=".csv,text/csv,.pdf,application/pdf,.txt,text/plain"
          onChange={(e) => {
            void send([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <strong>{busy ? "Saving…" : month ? "Add a file to this month" : "Add statements and invoices"}</strong>
        <span className="muted small">
          {month
            ? "Drop the owner statement (CSV) or invoice (PDF) here, or click to choose."
            : "Drop any number of owner statements (CSV) and invoices (PDF) here, or click to choose. Each one is filed under the month it covers."}
        </span>
      </label>
      {results.length > 0 && (
        <ul className="ms-results">
          {results.map((r) => (
            <li key={r.filename}>
              <span className={`badge ${r.status === "error" ? "err" : r.status === "conflict" ? "warn" : "ok"}`}>
                {r.status === "duplicate" ? "Already saved" : r.status[0]!.toUpperCase() + r.status.slice(1)}
              </span>{" "}
              <span className="ms-fname">{r.filename}</span> <span className="muted">{r.message}</span>
              {r.status === "conflict" && (
                <button className="btn small" disabled={busy} onClick={() => void send([r.file], true)}>
                  Replace
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------- year view ----------------

function YearView() {
  const { canWrite } = useSession();
  const navigate = useNavigate();
  const [year, setYear] = useState(() => Number(thisMonth().slice(0, 4)));
  const property = useProperty();
  const months = useApi<{ months: MonthRow[] }>(`manager/months?year=${year}${property.qs ? `&${property.qs}` : ""}`);
  const rows = months.data?.months ?? [];
  const saved = rows.filter((m) => m.status !== "empty");
  const open = saved.filter((m) => m.status !== "done");

  return (
    <div className="page ms">
      <header className="page-head">
        <h1>Manager statements</h1>
        {property.many && (
          <select value={property.id} onChange={(e) => property.setId(Number(e.target.value))} aria-label="Property">
            {property.active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="ms-year">
          <button className="icon-btn" onClick={() => setYear(year - 1)} aria-label="Previous year">
            ‹
          </button>
          <strong>{year}</strong>
          <button className="icon-btn" onClick={() => setYear(year + 1)} aria-label="Next year">
            ›
          </button>
        </div>
      </header>

      {canWrite && (
        <section className="card">
          <Upload onSaved={() => void months.reload()} />
        </section>
      )}

      {saved.length > 0 && (
        <section className={`ms-verdict ${open.length ? "warn" : "ok"}`}>
          <div>
            <h2>
              {open.length
                ? `${plural(open.length, "month")} need${open.length === 1 ? "s" : ""} attention`
                : `${plural(saved.length, "month")} checked: everything is recorded`}
            </h2>
            <p>
              {money(saved.reduce((s, m) => s + m.payouts, 0))} in payouts and{" "}
              {money(saved.reduce((s, m) => s + m.invoice_total, 0))} in invoices across the saved months.
            </p>
          </div>
        </section>
      )}

      <section className="card table-card">
        <table className="data-table ms-months">
          <thead>
            <tr>
              <th>Month</th>
              <th>Files</th>
              <th className="num">Payouts</th>
              <th className="num">Invoice</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr
                key={m.month}
                className={m.status === "empty" ? "excluded" : "clickable"}
                onClick={() => m.status !== "empty" && navigate(`/statement/${m.month}`)}
              >
                <td>
                  {m.status === "empty" ? (
                    monthTitle(m.month)
                  ) : (
                    <Link to={`/statement/${m.month}`}>{monthTitle(m.month)}</Link>
                  )}
                </td>
                <td className="muted small">
                  {[m.statement ? "Statement" : "", m.invoices.length ? plural(m.invoices.length, "invoice") : ""]
                    .filter(Boolean)
                    .join(" + ") || "—"}
                </td>
                <td className="num">{m.status === "empty" ? "" : money(m.payouts)}</td>
                <td className="num">{m.status === "empty" ? "" : money(m.invoice_total)}</td>
                <td>
                  <span className={`badge ${STATUS[m.status].badge}`} title={m.error}>
                    {STATUS[m.status].text(m)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {months.error && <p className="neg ms-foot">{months.error}</p>}
      </section>
    </div>
  );
}

// ---------------- month view ----------------

function MonthView({ month }: { month: string }) {
  const { canWrite } = useSession();
  const toast = useToast();
  const [subcategory, setSubcategory] = useState("");
  const [applied, setApplied] = useState("");
  const property = useProperty();
  const query = [property.qs, applied ? `subcategory=${encodeURIComponent(applied)}` : ""].filter(Boolean).join("&");
  const review = useApi<Review>(`manager/months/${month}${query ? `?${query}` : ""}`);
  const p = review.data;
  const documents = p?.documents ?? [];

  const [incomeSel, setIncomeSel] = useState<Set<string>>(new Set());
  const [lineSel, setLineSel] = useState<Set<string>>(new Set());
  const [lineCat, setLineCat] = useState<Record<string, number>>({});
  const [tagIncome, setTagIncome] = useState(true);
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Applied | null>(null);
  const [moving, setMoving] = useState<Record<number, string>>({});
  const [openTx, setOpenTx] = useState<number | null>(null);
  const [explaining, setExplaining] = useState<{ key: string } | null>(null);
  const explain = async (key: string, note: string | null) => {
    try {
      await api(`manager/months/${month}/explained${property.qs ? `?${property.qs}` : ""}`, {
        method: note === null ? "DELETE" : "POST",
        json: note === null ? { key } : { key, note },
      });
      setExplaining(null);
      reload();
      window.dispatchEvent(new Event("todo:changed"));
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  /** A badge that opens the ledger entry it refers to. */
  const txLink = (id: number | undefined, tone: string, text: string, key?: number) =>
    id ? (
      <button
        key={key}
        type="button"
        className={`badge ${tone} ms-link`}
        onClick={() => setOpenTx(id)}
        title="Open entry"
      >
        {text}
      </button>
    ) : (
      <span key={key} className={`badge ${tone}`}>
        {text}
      </span>
    );

  // Each fresh review pre-ticks everything that's missing.
  useEffect(() => {
    if (!p) return;
    setIncomeSel(new Set(p.income.filter((i) => i.status === "missing").map((i) => i.reservation_id)));
    setLineSel(new Set(p.lines.filter((l) => l.status === "missing").map((l) => l.key)));
    setLineCat({});
    setSubcategory((s) => s || p.subcategory);
  }, [p]);

  const reload = () => void review.reload();
  const toggle = <T,>(set: Set<T>, v: T, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(v);
    else n.delete(v);
    return n;
  };

  const apply = async () => {
    if (!p) return;
    const needCat = p.lines.filter((l) => lineSel.has(l.key) && !l.category_id && !lineCat[l.key]);
    if (needCat.length)
      return toast({ text: `Pick a category for "${needCat[0]!.item}" (or untick it)`, kind: "error" });
    setBusy(true);
    try {
      const overrides: Record<string, { category: number }> = {};
      for (const [k, c] of Object.entries(lineCat)) if (c) overrides[k] = { category: c };
      const res = await api<Applied>(`manager/months/${month}/apply`, {
        method: "POST",
        json: {
          property_id: property.many ? property.id : undefined,
          subcategory: p.subcategory,
          tag_income: tagIncome,
          attach,
          create_income: [...incomeSel],
          create_lines: [...lineSel],
          overrides,
        },
      });
      setDone(res);
      const added = res.created_expenses.length + res.created_income.length;
      toast({ text: added ? `Added ${plural(added, "entry", "entries")}` : "Saved", kind: "ok" });
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const removeDoc = async (d: Doc) => {
    if (!confirm(`Remove ${d.filename}? Entries already added stay in the ledger.`)) return;
    try {
      await api(`manager/documents/${d.id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  const moveDoc = async (d: Doc) => {
    const to = moving[d.id];
    if (!to || to === d.month) return;
    try {
      await api(`manager/documents/${d.id}`, { method: "PATCH", json: { month: to } });
      toast({ text: `Moved to ${monthTitle(to)}`, kind: "ok" });
      setMoving({});
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };

  const income = p?.income ?? [];
  const recorded = income.filter((i) => i.status !== "missing");
  const lines = p?.lines ?? [];
  const linesDone = lines.filter((l) => l.status === "exists");
  const toAdd = incomeSel.size + lineSel.size;
  const missingCount = income.length - recorded.length + (lines.length - linesDone.length);
  const needsLook = (p?.checks ?? []).filter((c) => c.level === "warn" && !c.code);
  const explained = (p?.checks ?? []).filter((c) => c.explained);
  const otherChecks = (p?.checks ?? []).filter((c) => (c.level !== "warn" || c.code) && !c.explained);
  const multiInvoice = (p?.invoices.length ?? 0) > 1;

  return (
    <div className="page ms">
      <header className="page-head">
        <div>
          <Link to="/statement" className="muted small">
            ← All months
          </Link>
          <h1>{monthTitle(month)}</h1>
        </div>
        <div className="ms-year">
          <Link className="icon-btn" to={`/statement/${shiftMonth(month, -1)}`} aria-label="Previous month">
            ‹
          </Link>
          <Link className="icon-btn" to={`/statement/${shiftMonth(month, 1)}`} aria-label="Next month">
            ›
          </Link>
        </div>
      </header>

      <section className="card">
        <h2>Files</h2>
        {documents.length ? (
          <ul className="ms-docs">
            {documents.map((d) => (
              <li key={d.id}>
                <div>
                  <a href={fileUrl(d)} target="_blank" rel="noreferrer">
                    {docLabel(d)}
                  </a>
                  <div className="muted small">
                    {d.filename} · saved {fmtDate(d.created_at.slice(0, 10))}
                  </div>
                </div>
                {canWrite && (
                  <div className="ms-doc-actions">
                    <input
                      type="month"
                      aria-label={`Month for ${d.filename}`}
                      value={moving[d.id] ?? d.month}
                      onChange={(e) => setMoving({ ...moving, [d.id]: e.target.value })}
                    />
                    {moving[d.id] && moving[d.id] !== d.month && (
                      <button className="btn small" onClick={() => void moveDoc(d)}>
                        Move
                      </button>
                    )}
                    <button className="btn small ghost" onClick={() => void removeDoc(d)}>
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing saved for this month yet.</p>
        )}
        {canWrite && <Upload month={month} onSaved={reload} />}
      </section>

      {review.error && !/No saved statement/.test(review.error) && <div className="alert error">{review.error}</div>}

      {p && documents.length > 0 && (
        <>
          <section className={`ms-verdict ${missingCount || needsLook.length ? "warn" : "ok"}`} aria-live="polite">
            <div>
              <h2>
                {missingCount
                  ? `${plural(missingCount, "thing")} missing from the ledger`
                  : needsLook.length
                    ? `Recorded, with ${plural(needsLook.length, "thing")} to check`
                    : "Everything is recorded"}
              </h2>
              <p>
                {[
                  income.length ? `${recorded.length} of ${plural(income.length, "payout")} recorded` : "",
                  lines.length ? `${linesDone.length} of ${plural(lines.length, "invoice line")} recorded` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            {canWrite && (
              <button className="btn primary" disabled={busy} onClick={() => void apply()}>
                {toAdd ? `Add ${plural(toAdd, "entry", "entries")}` : attach ? "Attach files to entries" : "Save"}
              </button>
            )}
          </section>

          {done && (
            <div className="alert ok">
              <p>
                Added {plural(done.created_income.length + done.created_expenses.length, "entry", "entries")}, noted the
                reservation on {plural(done.tagged.length, "payout")}
                {attach ? `, and linked the files to ${plural(done.attachments, "entry", "entries")}` : ""}.
              </p>
            </div>
          )}

          {needsLook.length > 0 && (
            <section className="card ms-look">
              <h2>Needs a look</h2>
              <ul>
                {needsLook.map((c, i) => (
                  <li key={c.key ?? i}>
                    {c.text}
                    {canWrite && c.key && explaining?.key !== c.key && (
                      <button className="btn small ghost ms-explain" onClick={() => setExplaining({ key: c.key! })}>
                        Mark as explained
                      </button>
                    )}
                    {explaining?.key === c.key && (
                      <ExplainForm onSave={(note) => void explain(c.key!, note)} onCancel={() => setExplaining(null)} />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {explained.length > 0 && (
            <section className="card ms-look">
              <h2>Explained</h2>
              <ul>
                {explained.map((c) => (
                  <li key={c.key}>
                    <span className="muted">{c.text}</span>
                    <div className="small">
                      {c.explained!.note ? `“${c.explained!.note}”` : "Marked as explained"} ·{" "}
                      {fmtDate(c.explained!.at.slice(0, 10))}
                      {canWrite && (
                        <button className="btn small ghost ms-explain" onClick={() => void explain(c.key!, null)}>
                          Reopen
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {income.length > 0 && (
            <details className="card table-card ms-block" open={income.length > recorded.length}>
              <summary>
                <span className="ms-title">Payouts</span>
                <span className="ms-sum">
                  {recorded.length} of {income.length} recorded · {money(income.reduce((s, i) => s + i.payout, 0))}
                </span>
              </summary>
              <table className="data-table">
                <tbody>
                  {income.map((r) => (
                    <tr key={r.reservation_id}>
                      <td className="ms-pick">
                        {r.status === "missing" && canWrite && (
                          <input
                            type="checkbox"
                            aria-label={`Add payout for the stay starting ${r.check_in}`}
                            checked={incomeSel.has(r.reservation_id)}
                            onChange={(e) => setIncomeSel(toggle(incomeSel, r.reservation_id, e.target.checked))}
                          />
                        )}
                      </td>
                      <td>
                        {fmtDate(r.check_in)} – {fmtDate(r.check_out)}
                        <div className="muted small">
                          {plural(r.nights, "night")} · {channelName(r.channel)} · #{r.reservation_id}
                        </div>
                      </td>
                      <td className="num">{money(r.payout)}</td>
                      <td className="ms-status">
                        {r.status === "matched" &&
                          r.transactions?.map((t, i) =>
                            txLink(
                              t.id,
                              "ok",
                              r.transactions!.length > 1
                                ? `${i === 0 ? "Deposit" : "Balance"} ${fmtDate(t.date)}`
                                : `Recorded ${fmtDate(t.date)}`,
                              t.id,
                            ),
                          )}
                        {r.status === "differs" &&
                          txLink(
                            r.transactions?.[0]?.id,
                            "warn",
                            `${money(r.transactions?.[0]?.amount)} deposited ${fmtDate(r.transaction_date ?? "")} (${r.difference! > 0 ? "+" : ""}${money(r.difference)})`,
                          )}
                        {r.status === "missing" && (
                          <span className={`badge ${incomeSel.has(r.reservation_id) ? "warn" : "err"}`}>
                            {incomeSel.has(r.reservation_id) ? "Will add" : "Not found"}
                          </span>
                        )}
                        {r.status === "batched" && (
                          <span className="badge muted" title="Paid through Stripe, combined with other bookings">
                            Paid via Stripe
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {income.some((i) => i.status === "missing") && (
                <p className="muted small ms-foot">
                  New payouts are dated two days after check-in and flagged for review, because the statement doesn't
                  say when the money arrived.
                </p>
              )}
              {p.unlisted_income.length > 0 && (
                <p className="muted small ms-foot">
                  Deposits in {monthTitle(month)} that no saved statement explains:{" "}
                  {p.unlisted_income.map((u) => `${fmtDate(u.date)} ${money(u.amount)}`).join(", ")}.
                </p>
              )}
            </details>
          )}

          {lines.length > 0 && (
            <details className="card table-card ms-block" open={lines.length > linesDone.length}>
              <summary>
                <span className="ms-title">
                  {multiInvoice ? "Invoices" : `Invoice${p.invoices[0]?.number ? ` #${p.invoices[0].number}` : ""}`}
                </span>
                <span className="ms-sum">
                  {linesDone.length} of {lines.length} recorded · {money(lines.reduce((s, l) => s + l.amount, 0))}
                  {!multiInvoice && p.invoices[0]?.paid ? ` · paid ${fmtDate(p.invoices[0].paid)}` : ""}
                </span>
              </summary>
              <table className="data-table">
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.key} className={l.status === "exists" ? "excluded" : ""}>
                      <td className="ms-pick">
                        {l.status !== "exists" && canWrite && (
                          <input
                            type="checkbox"
                            aria-label={`Add ${l.item}`}
                            checked={lineSel.has(l.key)}
                            onChange={(e) => setLineSel(toggle(lineSel, l.key, e.target.checked))}
                          />
                        )}
                      </td>
                      <td>
                        {l.item}
                        {multiInvoice && <span className="muted small"> · #{l.invoice}</span>}
                        {l.description && <div className="muted small">{l.description}</div>}
                      </td>
                      <td className="num">{money(l.amount)}</td>
                      <td className="ms-status">
                        {l.status === "exists" ? (
                          txLink(l.transaction_id, "ok", `Recorded · ${l.ledger_category ?? l.category}`)
                        ) : (
                          <select
                            value={lineCat[l.key] ?? l.category_id ?? ""}
                            onChange={(e) => setLineCat({ ...lineCat, [l.key]: Number(e.target.value) })}
                            aria-label={`Category for ${l.item}`}
                          >
                            <option value="">Choose a category…</option>
                            {p.categories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {lineSel.size > 0 && (
                <p className="muted small ms-foot">
                  New lines are dated {fmtDate(lines[0]?.date ?? "")}, the end of the month
                  {p.subcategory ? `, under ${p.subcategory}` : ""}.
                </p>
              )}
            </details>
          )}

          <details className="card ms-block ms-more">
            <summary>
              <span className="ms-title">Checks and options</span>
              <span className="ms-sum">{plural(otherChecks.length, "check")} passed or noted</span>
            </summary>
            <ul className="ms-checks">
              {otherChecks.map((c, i) => (
                <li key={i}>
                  <span className={`badge ${c.level}`}>
                    {c.level === "ok" ? "OK" : c.level === "info" ? "Note" : "Check"}
                  </span>{" "}
                  {c.text}
                </li>
              ))}
            </ul>
            {canWrite && (
              <>
                <div className="ms-options">
                  <label>
                    Manager (subcategory)
                    <input value={subcategory} onChange={(e) => setSubcategory(e.target.value)} />
                  </label>
                  <button
                    className="btn"
                    disabled={subcategory === p.subcategory}
                    onClick={() => setApplied(subcategory)}
                  >
                    Check again
                  </button>
                </div>
                <label className="check">
                  <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach the
                  invoice to each of its entries and the statement to the management-fee entry
                </label>
                <label className="check">
                  <input type="checkbox" checked={tagIncome} onChange={(e) => setTagIncome(e.target.checked)} /> Note
                  the reservation number on recorded payouts (only where the description is empty)
                </label>
              </>
            )}
          </details>
        </>
      )}
      {openTx && <TxEditModal id={openTx} onClose={() => setOpenTx(null)} onChanged={reload} />}
    </div>
  );
}

function ExplainForm({ onSave, onCancel }: { onSave: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState("");
  return (
    <form
      className="ms-explain-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(note.trim());
      }}
    >
      <input
        autoFocus
        placeholder="What's the explanation? (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label="Explanation"
      />
      <button className="btn small primary">Save</button>
      <button type="button" className="btn small ghost" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

export default function ManagerStatement() {
  const { month } = useParams();
  return month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? <MonthView key={month} month={month} /> : <YearView />;
}
