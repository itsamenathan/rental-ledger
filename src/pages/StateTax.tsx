import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { api, qs } from "../api.ts";
import { fmtDate, money, monthTitle, today, THIS_YEAR } from "../format.ts";
import { useApi, usePersistentState, useProperty, useScopedPath, useSession, useToast } from "../hooks.ts";
import { Modal, YearSelect } from "../lib.tsx";
import TxEditModal from "../components/TxEditModal.tsx";
import { dueText } from "../state-tax.ts";

/** One quarter from GET /api/state-tax (server/services/state-tax.ts). */
interface StateTaxQuarter {
  year: number;
  quarter: number;
  label: string;
  start: string;
  end: string;
  due_date: string;
  days_left: number;
  status: "paid" | "overdue" | "open" | "in_progress";
  gross: number;
  taxes_collected: number;
  reservations: {
    reservation_id: string;
    channel: string;
    guest: string;
    check_in: string;
    check_out: string;
    nights: number;
    payout: number;
    taxes: number;
    statement_month: string;
  }[];
  excluded: { airbnb: { count: number; payout: number }; cancelled: { count: number; payout: number } };
  statement_months: string[];
  missing_months: string[];
  complete: boolean;
  warnings: string[];
  notes: string[];
  filing: null | {
    id: number;
    gross_filed: number | null;
    amount_paid: number;
    paid_date: string;
    confirmation: string;
    transaction_id: number | null;
    created_by: string | null;
    expense: null | { id: number; date: string; amount: number; deleted: boolean };
    expense_warning: string | null;
  };
  candidates: { id: number; date: string; amount: number; vendor: string; description: string }[];
}
interface StateTaxYear {
  property: { id: number; name: string; location_id: string };
  year: number;
  category: string;
  reminders: boolean;
  quarters: StateTaxQuarter[];
}

const STATUS: Record<StateTaxQuarter["status"], { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "ok" },
  overdue: { label: "Overdue", cls: "err" },
  open: { label: "Due", cls: "warn" },
  in_progress: { label: "Quarter not over", cls: "muted" },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Before the first return of the year is due (Apr 20), show last year, whose Q4 is still open. */
const DEFAULT_YEAR = THIS_YEAR - (new Date().getMonth() < 3 ? 1 : 0);

async function copy(text: string, toast: ReturnType<typeof useToast>, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ text: `Copied ${what}`, kind: "ok" });
  } catch {
    toast({ text: `Couldn't copy; select it instead`, kind: "error" });
  }
}

/**
 * Quarterly state sales tax for one property: the gross to file on each return (owner payouts of non-Airbnb stays,
 * from saved manager statements), when it's due, and the payment once made.
 */
export default function StateTax() {
  const [params] = useSearchParams();
  const opened = params.get("year") ? Number(params.get("year")) : undefined;
  const [year, setYear] = usePersistentState("state-tax-year", DEFAULT_YEAR, opened);
  const propertyId = useProperty().single;
  const { canWrite } = useSession();
  const { data, error, reload } = useApi<StateTaxYear>(`state-tax${qs({ year, property_id: propertyId })}`);
  const [paying, setPaying] = useState<StateTaxQuarter | null>(null);
  const [clearing, setClearing] = useState<StateTaxQuarter | null>(null);
  const [openTx, setOpenTx] = useState<number | null>(null);
  const changed = () => {
    void reload();
    window.dispatchEvent(new Event("todo:changed"));
  };

  return (
    <div className="page state-tax">
      <header className="page-head">
        <h1>State sales tax</h1>
        <div className="head-actions">
          <YearSelect value={year} onChange={setYear} />
        </div>
      </header>
      {error && <div className="alert error">{error}</div>}
      {data && (
        <>
          <LocationCard data={data} onChange={changed} />
          {data.quarters.map((q) => (
            <QuarterCard
              key={q.quarter}
              q={q}
              canWrite={canWrite}
              onPay={() => setPaying(q)}
              onClear={() => setClearing(q)}
              onOpenTx={setOpenTx}
            />
          ))}
          <p className="muted small">
            The gross is what the manager paid you (the owner payout) for every stay not booked through Airbnb, which
            collects and remits its own tax, counted in the quarter the guest checked in. It's read from the saved
            manager statements. The state works out the tax from the gross; enter what you paid when you mark a quarter
            paid, and it's added as a {data.category} expense (no subcategory, direct).
          </p>
        </>
      )}
      {paying && data && (
        <PayModal
          q={paying}
          propertyId={data.property.id}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            changed();
          }}
        />
      )}
      {clearing && data && (
        <ClearModal
          q={clearing}
          propertyId={data.property.id}
          onClose={() => setClearing(null)}
          onDone={() => {
            setClearing(null);
            changed();
          }}
        />
      )}
      {openTx && <TxEditModal id={openTx} onClose={() => setOpenTx(null)} onChanged={changed} />}
    </div>
  );
}

function LocationCard({ data, onChange }: { data: StateTaxYear; onChange: () => void }) {
  const { canWrite, reloadOverview } = useSession();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const id = data.property.location_id;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("state-tax/location", {
        method: "PUT",
        json: { property_id: data.property.id, location_id: editing ?? "" },
      });
      setEditing(null);
      await reloadOverview();
      onChange();
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  return (
    <section className="card st-location">
      {editing != null ? (
        <form onSubmit={save} className="st-location-form">
          <label>
            Location ID
            <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} maxLength={50} />
          </label>
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn primary">Save</button>
          </div>
        </form>
      ) : (
        <div className="st-location-row">
          <div>
            <div className="tile-label">Location ID</div>
            {id ? <div className="st-location-id">{id}</div> : <div className="muted">Not set</div>}
          </div>
          <div className="st-location-actions">
            {id && (
              <button className="btn small" onClick={() => void copy(id, toast, "the Location ID")}>
                Copy
              </button>
            )}
            {canWrite && (
              <button className="btn small ghost" onClick={() => setEditing(id)}>
                {id ? "Edit" : "Add"}
              </button>
            )}
          </div>
        </div>
      )}
      <p className="muted small st-location-note">
        {id || data.reminders
          ? "Returns are due the 20th of the month after each quarter. The To do list reminds you two weeks before."
          : "Add the Location ID of this property's sales tax account to get To do reminders before each return is due."}
      </p>
    </section>
  );
}

function QuarterCard({
  q,
  canWrite,
  onPay,
  onClear,
  onOpenTx,
}: {
  q: StateTaxQuarter;
  canWrite: boolean;
  onPay: () => void;
  onClear: () => void;
  onOpenTx: (id: number) => void;
}) {
  const toast = useToast();
  const scoped = useScopedPath();
  const st = STATUS[q.status];
  const f = q.filing;
  const ended = q.status !== "in_progress";
  return (
    <section className="card st-quarter">
      <div className="section-head">
        <h2>
          {q.label} <span className={`badge ${st.cls}`}>{st.label}</span>
        </h2>
        {canWrite && !f && ended && (
          <button className="btn primary small" onClick={onPay}>
            Mark paid
          </button>
        )}
      </div>
      <p className="muted small st-sub">
        Stays checking in {shortDate(q.start)} – {shortDate(q.end)}
        {" · "}
        {f ? `due ${fmtDate(q.due_date)}` : dueText(q)}
      </p>

      <div className="st-figures">
        <div>
          <div className="tile-label">Gross to file</div>
          <div className="st-gross">
            <span className="tile-value">{money(q.gross)}</span>
            {q.gross > 0 && (
              <button
                className="btn small ghost"
                onClick={() => void copy(q.gross.toFixed(2), toast, `the ${q.label} gross`)}
              >
                Copy
              </button>
            )}
          </div>
          <div className="tile-sub">
            {plural(q.reservations.length, "stay")}
            {q.excluded.airbnb.count > 0 && ` · ${plural(q.excluded.airbnb.count, "Airbnb stay")} left out`}
          </div>
        </div>
        <div>
          <div className="tile-label">Lodging tax on statements</div>
          <div className="tile-value st-secondary">{money(q.taxes_collected)}</div>
          <div className="tile-sub">collected from guests, to cross-check</div>
        </div>
        {f && (
          <div>
            <div className="tile-label">Paid</div>
            <div className="tile-value st-secondary">{money(f.amount_paid)}</div>
            <div className="tile-sub">
              {fmtDate(f.paid_date)}
              {f.confirmation && ` · #${f.confirmation}`}
            </div>
          </div>
        )}
      </div>

      {q.warnings.length > 0 && (
        <div className="alert warn st-alert">
          {q.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          {q.missing_months.length > 0 && (
            <Link className="link small" to={scoped(`/statement/${q.missing_months[0]}`)}>
              Add the {monthTitle(q.missing_months[0]!)} statement
            </Link>
          )}
        </div>
      )}
      {q.notes.map((n) => (
        <p key={n} className="muted small">
          {n}
        </p>
      ))}

      {f && (
        <div className="st-paid">
          <span>
            {f.gross_filed != null && <>Gross filed {money(f.gross_filed)}. </>}
            {f.expense ? (
              <button className="link" onClick={() => onOpenTx(f.expense!.id)} disabled={f.expense.deleted}>
                Expense of {fmtDate(f.expense.date)}
              </button>
            ) : (
              "No expense linked."
            )}
          </span>
          {canWrite && (
            <button className="btn small ghost" onClick={onClear}>
              Undo paid
            </button>
          )}
          {f.expense_warning && <div className="alert warn st-alert">{f.expense_warning}</div>}
        </div>
      )}

      {q.reservations.length > 0 && (
        <details className="st-details">
          <summary>Stays in the gross</summary>
          <div className="table-card st-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Check-in</th>
                  <th>Check-out</th>
                  <th>Channel</th>
                  <th>Reservation</th>
                  <th className="num">Payout</th>
                  <th className="num">Tax</th>
                </tr>
              </thead>
              <tbody>
                {q.reservations.map((r) => (
                  <tr key={r.reservation_id}>
                    <td>{shortDate(r.check_in)}</td>
                    <td>{shortDate(r.check_out)}</td>
                    <td>{r.channel || <span className="muted">none</span>}</td>
                    <td className="muted small" title={r.guest}>
                      {r.reservation_id}
                    </td>
                    <td className="num">{money(r.payout)}</td>
                    <td className="num">{money(r.taxes)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>Total</td>
                  <td className="num">{money(q.gross)}</td>
                  <td className="num">{money(q.taxes_collected)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function PayModal({
  q,
  propertyId,
  onClose,
  onDone,
}: {
  q: StateTaxQuarter;
  propertyId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<"new" | "link">(q.candidates.length ? "link" : "new");
  const [linkId, setLinkId] = useState<number | null>(q.candidates.length === 1 ? q.candidates[0]!.id : null);
  const [paidDate, setPaidDate] = useState(today());
  const [amount, setAmount] = useState("");
  // Prefilled only when the statements cover the whole quarter; otherwise the computed gross may be short.
  const [gross, setGross] = useState(q.complete ? q.gross.toFixed(2) : "");
  const [confirmation, setConfirmation] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      let upload_ids: number[] | undefined;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        const up = await api<{ id: number }>("uploads", { method: "POST", body: form });
        upload_ids = [up.id];
      }
      const common = {
        property_id: propertyId,
        confirmation,
        gross_filed: gross.trim() === "" ? null : Number(gross),
        upload_ids,
      };
      if (mode === "link") {
        if (!linkId) throw new Error("Pick the expense that paid this return");
        await api(`state-tax/${q.year}/${q.quarter}/link`, {
          method: "POST",
          json: { ...common, transaction_id: linkId },
        });
      } else {
        await api(`state-tax/${q.year}/${q.quarter}/paid`, {
          method: "POST",
          json: { ...common, paid_date: paidDate, amount_paid: Number(amount) },
        });
      }
      toast({ text: `${q.label} marked paid`, kind: "ok" });
      onDone();
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
      setBusy(false);
    }
  };

  return (
    <Modal title={`Mark ${q.label} paid`} onClose={onClose}>
      <form onSubmit={submit}>
        {q.candidates.length > 0 && (
          <fieldset className="st-mode">
            <label className="check">
              <input type="radio" checked={mode === "link"} onChange={() => setMode("link")} /> It's already in the
              ledger
            </label>
            <label className="check">
              <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> Add the payment as a new
              expense
            </label>
          </fieldset>
        )}
        {mode === "link" ? (
          <ul className="st-candidates">
            {q.candidates.map((c) => (
              <li key={c.id}>
                <label className="check">
                  <input type="radio" name="link" checked={linkId === c.id} onChange={() => setLinkId(c.id)} />{" "}
                  {fmtDate(c.date)} · {money(c.amount)}
                  {(c.description || c.vendor) && <span className="muted"> · {c.description || c.vendor}</span>}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <div className="row-2">
            <label>
              Date paid
              <input type="date" required value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
            </label>
            <label>
              Amount paid ($)
              <input
                inputMode="decimal"
                required
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </label>
          </div>
        )}
        <div className="row-2">
          <label>
            Gross filed ($)
            <input
              inputMode="decimal"
              value={gross}
              onChange={(e) => setGross(e.target.value)}
              placeholder={q.complete ? "" : "From the return"}
            />
          </label>
          <label>
            Confirmation number
            <input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="Optional" />
          </label>
        </div>
        <label>
          Confirmation (optional)
          <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <p className="muted small">
          {mode === "link"
            ? "The expense is kept as it is and linked to this return; a file is attached to it."
            : "Adds a Taxes expense (no subcategory, direct) for the amount paid, with the file attached."}
        </p>
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "Saving…" : "Mark paid"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ClearModal({
  q,
  propertyId,
  onClose,
  onDone,
}: {
  q: StateTaxQuarter;
  propertyId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const hasExpense = !!q.filing?.expense && !q.filing.expense.deleted;
  const clear = async (trash: boolean) => {
    try {
      await api(
        `state-tax/${q.year}/${q.quarter}/paid${qs({ property_id: propertyId, trash_expense: trash || undefined })}`,
        { method: "DELETE" },
      );
      toast({ text: trash ? `${q.label} unmarked; expense moved to the trash` : `${q.label} unmarked`, kind: "ok" });
      onDone();
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  return (
    <Modal title={`Undo ${q.label} paid`} onClose={onClose}>
      <p>
        {hasExpense
          ? "The quarter goes back to unpaid. Keep the expense in the ledger (you can link it again), or move it to the trash?"
          : "The quarter goes back to unpaid."}
      </p>
      <div className="form-actions">
        <span className="spacer" />
        {hasExpense && (
          <button className="btn ghost" onClick={() => void clear(true)}>
            Trash expense
          </button>
        )}
        <button className="btn primary" onClick={() => void clear(false)}>
          {hasExpense ? "Keep expense" : "Undo paid"}
        </button>
      </div>
    </Modal>
  );
}
