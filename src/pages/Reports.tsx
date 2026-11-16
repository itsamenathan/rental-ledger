import { useState } from "react";
import { Link } from "react-router";
import { api, qs } from "../api.ts";
import { money, percent, THIS_YEAR } from "../format.ts";
import { useApi, usePersistentState, useSession, useToast } from "../hooks.ts";
import { YearSelect } from "../lib.tsx";

interface Line {
  category_id: number;
  category: string;
  schedule_e_line: string | null;
  amount: number;
  count: number;
}
interface TaxReport {
  year: number;
  property: { id: number; name: string; address: string };
  inputs: {
    mortgage_interest: number | null;
    rental_days_override: number | null;
    personal_days_override: number | null;
    notes: string;
  };
  income: { total: number; by_category: Line[]; by_payer: { payer: string; amount: number; count: number }[] };
  expenses: Record<"direct" | "indirect" | "unallocated", { total: number; by_category: Line[] }>;
  use: {
    rental_days: number;
    personal_days: number;
    rental_pct: number;
    source: string;
    nights_available: number;
    check_ins: number;
    avg_stay: number | null;
  };
  allocation: { indirect_total: number; indirect_deductible: number; indirect_personal: number };
  mortgage: { payments_recorded: number; interest_1098: number | null };
  depreciation: null | {
    basis: number;
    placed_in_service: string;
    recovery_years: number;
    full_year: number;
    accumulated_before: number;
    allocated: number;
  };
  schedule_e: {
    line: string;
    label: string;
    direct: number;
    indirect: number;
    indirect_allocated: number;
    total: number;
  }[];
  totals: {
    gross_income: number;
    direct_expenses: number;
    indirect_expenses: number;
    deductible_expenses: number;
    net: number;
  };
  checks: { level: "error" | "warning" | "info"; code: string; message: string; ids?: number[] }[];
  disclaimer: string;
}

const LEVEL = {
  error: { icon: "✕", label: "Fix" },
  warning: { icon: "!", label: "Check" },
  info: { icon: "i", label: "Note" },
};

/** Before April, default to last year's return. Read once at load. */
const DEFAULT_TAX_YEAR = THIS_YEAR - (new Date().getMonth() < 3 ? 1 : 0);

export default function Reports() {
  const { overview, canWrite } = useSession();
  const [year, setYear] = usePersistentState("tax-year", DEFAULT_TAX_YEAR);
  const props = overview.properties.filter((p) => !p.archived);
  const [propertyId, setPropertyId] = useState(props[0]?.id ?? 0);
  const { data: r, error, reload } = useApi<TaxReport>(`reports/tax${qs({ year, property_id: propertyId })}`);

  return (
    <div className="page report">
      <header className="page-head no-print">
        <h1>Tax report</h1>
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
          <YearSelect value={year} onChange={setYear} />
          <a
            className="btn primary"
            href={`/api/reports/tax-package.zip${qs({ year, property_id: propertyId })}`}
            title="Summary, tax CSV, all transactions and receipts for the year, in one zip"
          >
            Download for preparer
          </a>
          <button className="btn" onClick={() => window.print()}>
            Print / PDF
          </button>
        </div>
      </header>
      {error && <div className="alert error">{error}</div>}
      {r && (
        <>
          <div className="print-only print-title">
            <h1>
              {r.property.name} — {r.year} rental income &amp; expenses
            </h1>
            {r.property.address && <p>{r.property.address}</p>}
          </div>

          {r.checks.length > 0 && (
            <section className="card no-print-break">
              <h2>Before you file</h2>
              <ul className="checks">
                {r.checks.map((c) => (
                  <li key={c.code} className={`check-item ${c.level}`}>
                    <span className="status-icon" aria-hidden="true">
                      {LEVEL[c.level].icon}
                    </span>
                    <span>
                      <strong>{LEVEL[c.level].label}: </strong>
                      {c.message}{" "}
                      {c.ids && c.ids.length > 0 && (
                        <Link className="no-print" to={checkLink(c.code, r.year)}>
                          Show
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="tiles">
            <div className="tile">
              <span className="tile-label">Gross rental income</span>
              <span className="tile-value">{money(r.totals.gross_income)}</span>
            </div>
            <div className="tile">
              <span className="tile-label">Direct expenses</span>
              <span className="tile-value">{money(r.totals.direct_expenses)}</span>
              <span className="tile-sub">100% deductible</span>
            </div>
            <div className="tile">
              <span className="tile-label">Indirect expenses</span>
              <span className="tile-value">{money(r.totals.indirect_expenses)}</span>
              <span className="tile-sub">
                {money(r.allocation.indirect_deductible)} deductible at {percent(r.use.rental_pct)}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Estimated net (Schedule E)</span>
              <span className={`tile-value ${r.totals.net < 0 ? "neg" : ""}`}>{money(r.totals.net)}</span>
            </div>
          </div>

          <div className="grid-2">
            <section className="card">
              <h2>Direct expenses</h2>
              <p className="muted small">
                Spent only because of the rental (guest cleaning, commissions, management, guest supplies). Fully
                deductible.
              </p>
              <LineTable
                lines={r.expenses.direct.by_category}
                total={r.expenses.direct.total}
                year={r.year}
                allocation="direct"
              />
            </section>
            <section className="card">
              <h2>Indirect expenses</h2>
              <p className="muted small">
                Benefit the whole property. Prorated by rental use ({percent(r.use.rental_pct)}).
              </p>
              <LineTable
                lines={r.expenses.indirect.by_category}
                total={r.expenses.indirect.total}
                year={r.year}
                allocation="indirect"
              />
              <dl className="kv">
                <dt>Rental share ({percent(r.use.rental_pct)})</dt>
                <dd>{money(r.allocation.indirect_deductible)}</dd>
                <dt>Personal share</dt>
                <dd>{money(r.allocation.indirect_personal)}</dd>
              </dl>
            </section>
          </div>

          {r.expenses.unallocated.by_category.length > 0 && (
            <section className="card">
              <h2>Not yet marked direct or indirect</h2>
              <LineTable
                lines={r.expenses.unallocated.by_category}
                total={r.expenses.unallocated.total}
                year={r.year}
                allocation="none"
              />
            </section>
          )}

          <div className="grid-2">
            <section className="card">
              <h2>Rental vs personal use</h2>
              <dl className="kv">
                <dt>Days rented at fair price</dt>
                <dd>{r.use.rental_days}</dd>
                <dt>Personal-use days</dt>
                <dd>{r.use.personal_days}</dd>
                <dt>Rental use %</dt>
                <dd>
                  <strong>{percent(r.use.rental_pct, 2)}</strong>
                </dd>
                <dt>Check-ins</dt>
                <dd>{r.use.check_ins}</dd>
                <dt>Average stay</dt>
                <dd>{r.use.avg_stay ?? "—"} nights</dd>
                <dt>Source</dt>
                <dd>{r.use.source === "override" ? "Manual override" : "Occupancy records"}</dd>
              </dl>
            </section>
            <section className="card">
              <h2>Income</h2>
              <LineTable lines={r.income.by_category} total={r.income.total} year={r.year} />
              <h3>By payer</h3>
              <p className="muted small">
                Compare with each platform's Form 1099-K. Payouts are usually net of platform fees.
              </p>
              <table className="data-table">
                <tbody>
                  {r.income.by_payer.map((p) => (
                    <tr key={p.payer}>
                      <td>{p.payer}</td>
                      <td className="muted">{p.count} payouts</td>
                      <td className="num">{money(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="card">
            <h2>Schedule E summary</h2>
            <div className="sched-e-wrap">
              <table className="data-table sched-e">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th className="num">Direct</th>
                    <th className="num">Indirect</th>
                    <th className="num">Indirect × {percent(r.use.rental_pct)}</th>
                    <th className="num">Deductible</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>3 · Rents received</td>
                    <td colSpan={3} />
                    <td className="num">{money(r.totals.gross_income)}</td>
                  </tr>
                  {r.schedule_e.map((l) => (
                    <tr key={l.line}>
                      <td>
                        {l.line} · {l.label}
                      </td>
                      <td className="num">{l.direct ? money(l.direct) : ""}</td>
                      <td className="num">{l.indirect ? money(l.indirect) : ""}</td>
                      <td className="num">{l.indirect ? money(l.indirect_allocated) : ""}</td>
                      <td className="num">{money(l.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>20 · Total expenses</td>
                    <td colSpan={3} />
                    <td className="num">{money(r.totals.deductible_expenses)}</td>
                  </tr>
                  <tr>
                    <td>21 · Income or (loss)</td>
                    <td colSpan={3} />
                    <td className="num">
                      <strong>{money(r.totals.net)}</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {r.depreciation && (
              <p className="muted small">
                Depreciation: {money(r.depreciation.basis)} basis over {r.depreciation.recovery_years} years from{" "}
                {r.depreciation.placed_in_service} (mid-month) = {money(r.depreciation.full_year)} for {r.year}; prior
                accumulated {money(r.depreciation.accumulated_before)}.
              </p>
            )}
          </section>

          <TaxInputs
            key={`${r.property.id}-${r.year}-${JSON.stringify(r.inputs)}`}
            year={r.year}
            propertyId={r.property.id}
            inputs={r.inputs}
            payments={r.mortgage.payments_recorded}
            canWrite={canWrite}
            onSaved={reload}
          />
          <p className="disclaimer">{r.disclaimer}</p>
        </>
      )}
    </div>
  );
}

function checkLink(code: string, year: number) {
  const q: Record<string, string> = {
    needs_review: `/todo`,
    unallocated: `/transactions?year=${year}&kind=expense&allocation=none`,
    missing_receipts: `/transactions?year=${year}&needs_receipt=true`,
    capitalize: `/transactions?year=${year}&kind=expense&min_amount=2500`,
  };
  return q[code] ?? `/transactions?year=${year}`;
}

function LineTable({
  lines,
  total,
  year,
  allocation,
}: {
  lines: Line[];
  total: number;
  year: number;
  allocation?: string;
}) {
  if (!lines.length) return <p className="muted">None.</p>;
  return (
    <table className="data-table">
      <tbody>
        {lines.map((l) => (
          <tr key={l.category_id}>
            <td>
              <Link to={`/transactions${qs({ year, category: l.category_id, allocation })}`}>{l.category}</Link>
              {l.schedule_e_line && <small className="muted"> · line {l.schedule_e_line}</small>}
            </td>
            <td className="muted num">{l.count}</td>
            <td className="num">{money(l.amount)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td />
          <td className="num">{money(total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function TaxInputs({
  year,
  propertyId,
  inputs,
  payments,
  canWrite,
  onSaved,
}: {
  year: number;
  propertyId: number;
  inputs: TaxReport["inputs"];
  payments: number;
  canWrite: boolean;
  onSaved: () => void;
}) {
  const [interest, setInterest] = useState(inputs.mortgage_interest?.toString() ?? "");
  const [rental, setRental] = useState(inputs.rental_days_override?.toString() ?? "");
  const [personal, setPersonal] = useState(inputs.personal_days_override?.toString() ?? "");
  const [notes, setNotes] = useState(inputs.notes);
  const toast = useToast();
  const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(/[$,]/g, "")));
  const save = async () => {
    try {
      await api(`tax-years/${year}`, {
        method: "PUT",
        json: {
          property_id: propertyId,
          mortgage_interest: num(interest),
          rental_days_override: num(rental),
          personal_days_override: num(personal),
          notes,
        },
      });
      toast({ text: "Tax inputs saved", kind: "ok" });
      onSaved();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  return (
    <section className="card no-print">
      <h2>{year} tax inputs</h2>
      <div className="row-3">
        <label>
          Mortgage interest (Form 1098)
          <input
            inputMode="decimal"
            value={interest}
            onChange={(e) => setInterest(e.target.value)}
            disabled={!canWrite}
            placeholder={payments ? `Payments recorded: ${money(payments)}` : ""}
          />
        </label>
        <label>
          Rental days override
          <input
            inputMode="numeric"
            value={rental}
            onChange={(e) => setRental(e.target.value)}
            disabled={!canWrite}
            placeholder="From occupancy"
          />
        </label>
        <label>
          Personal days override
          <input
            inputMode="numeric"
            value={personal}
            onChange={(e) => setPersonal(e.target.value)}
            disabled={!canWrite}
            placeholder="From occupancy"
          />
        </label>
      </div>
      <label>
        Notes for your preparer
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canWrite} />
      </label>
      {canWrite && (
        <button className="btn primary" onClick={() => void save()}>
          Save inputs
        </button>
      )}
    </section>
  );
}
