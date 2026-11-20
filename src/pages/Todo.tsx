import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api, type Recurring, type Transaction, type TxList } from "../api.ts";
import AttentionList from "../components/AttentionList.tsx";
import TxEditModal from "../components/TxEditModal.tsx";
import { CandidateList, GuestNightList } from "../components/OwnerStays.tsx";
import type { MonthCompare, StayCandidate } from "../owner-stays.ts";
import { fmtDate, monthTitle } from "../format.ts";
import { useApi, useSession, useToast, useProperty } from "../hooks.ts";
import { Amount } from "../lib.tsx";

export interface TodoSummary {
  total: number;
  flagged: number;
  unallocated: number;
  recurring: number;
  recurring_notes: number;
  missing_receipts: number;
  manager: number;
  manager_months: { property_id: number; month: string; to_add: number; to_check: number }[];
  occupancy: number;
  occupancy_items: {
    property_id: number;
    property: string;
    owner_stays: StayCandidate[];
    guest_nights: MonthCompare[];
  }[];
}

const year = new Date().getFullYear();

/** One place for everything that needs a look: flagged entries, missing tax treatment, recurring-bill alerts. */
export default function Todo() {
  const { path: scoped, qs: pq } = useProperty();
  const flagged = useApi<TxList>(`transactions?needs_review=true&sort=date_asc&limit=500&${pq}`);
  const unallocated = useApi<TxList>(`transactions?kind=expense&allocation=none&sort=date_asc&limit=500&${pq}`);
  const rec = useApi<Recurring>(`recurring?${pq}`);
  const summary = useApi<TodoSummary>(`todo?${pq}`);
  const managerMonths = summary.data?.manager_months ?? [];
  const occ = summary.data?.occupancy_items ?? [];
  // the property name only matters when the list covers several
  const name = (o: (typeof occ)[number]) => (occ.length > 1 ? o.property : undefined);
  const ownerStays = occ.flatMap((o) =>
    o.owner_stays.map((c) => ({ ...c, property_id: o.property_id, property: name(o) })),
  );
  const guestNights = occ.flatMap((o) =>
    o.guest_nights.map((m) => ({ ...m, property_id: o.property_id, property: name(o) })),
  );
  const [editing, setEditing] = useState<number | null>(null);
  const { canWrite } = useSession();
  const toast = useToast();

  const reloadAll = () => {
    void flagged.reload();
    void unallocated.reload();
    void rec.reload();
    void summary.reload();
    window.dispatchEvent(new Event("todo:changed"));
  };
  const patch = async (id: number, json: Record<string, unknown>, text: string) => {
    try {
      await api(`transactions/${id}`, { method: "PATCH", json });
      toast({ text, kind: "ok" });
      reloadAll();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };

  const loaded = flagged.data && unallocated.data && rec.data;
  const warnings = rec.data?.alerts.filter((a) => a.level === "warning") ?? [];
  const notes = rec.data?.alerts.filter((a) => a.level === "info") ?? [];
  const nothing =
    loaded &&
    !flagged.data!.total &&
    !unallocated.data!.total &&
    !rec.data!.alerts.length &&
    !managerMonths.length &&
    !occ.length;

  return (
    <div className="page">
      <header className="page-head">
        <h1>To do</h1>
      </header>
      {nothing && (
        <div className="card all-clear">
          <strong>✓ All caught up.</strong> Nothing is flagged, every expense has a tax treatment, and recurring bills
          are up to date.
        </div>
      )}

      {flagged.data && flagged.data.total > 0 && (
        <Section
          title="Check these entries"
          count={flagged.data.total}
          help="Flagged by you, an import, or an AI agent that wasn't sure. Fix anything that's wrong, then mark it OK."
        >
          <EntryList items={flagged.data.items} onOpen={setEditing}>
            {(tx) =>
              canWrite && (
                <button
                  className="btn primary small"
                  onClick={() => void patch(tx.id, { needs_review: false }, "Marked OK")}
                >
                  ✓ Looks right
                </button>
              )
            }
          </EntryList>
        </Section>
      )}

      {unallocated.data && unallocated.data.total > 0 && (
        <Section
          title="Only the rental, or the whole property?"
          count={unallocated.data.total}
          help="These expenses are left out of the tax report until you pick. Rental-only (direct) is deducted in full; whole-property (indirect) is split by rental days."
        >
          <EntryList items={unallocated.data.items} onOpen={setEditing}>
            {(tx) =>
              canWrite && (
                <>
                  <button
                    className="btn small"
                    onClick={() => void patch(tx.id, { allocation: "direct" }, "Set to direct")}
                  >
                    Rental only
                  </button>
                  <button
                    className="btn small"
                    onClick={() => void patch(tx.id, { allocation: "indirect" }, "Set to indirect")}
                  >
                    Whole property
                  </button>
                </>
              )
            }
          </EntryList>
        </Section>
      )}

      {rec.data && rec.data.alerts.length > 0 && (
        <Section
          title="Recurring bills"
          count={warnings.length}
          help={
            <>
              Based on what you usually pay each month or quarter.{" "}
              <Link to={scoped("/recurring")}>See everything it tracks →</Link>
            </>
          }
        >
          <AttentionList alerts={[...warnings, ...notes]} series={rec.data.series} onChanged={reloadAll} />
        </Section>
      )}

      {managerMonths.length > 0 && (
        <Section
          title="Manager statements"
          count={managerMonths.length}
          help="Months where the manager's statement or invoice has entries missing from the ledger, or a difference nobody has explained yet."
        >
          <ul className="plain-list">
            {managerMonths.map((m) => (
              <li key={`${m.property_id}-${m.month}`}>
                <Link to={scoped(`/statement/${m.month}`)}>{monthTitle(m.month)}</Link>{" "}
                <span className="muted">
                  {[
                    m.to_add ? `${m.to_add} ${m.to_add === 1 ? "entry" : "entries"} to add` : "",
                    m.to_check ? `${m.to_check} ${m.to_check === 1 ? "thing" : "things"} to check` : "",
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {ownerStays.length > 0 && (
        <Section
          title="Did you stay here?"
          count={ownerStays.length}
          help={
            <>
              Blocked on every booking calendar with no guest. Your stays count as personal days at tax time.{" "}
              <Link to={scoped("/occupancy")}>Occupancy →</Link>
            </>
          }
        >
          <CandidateList items={ownerStays} onChange={reloadAll} />
        </Section>
      )}

      {guestNights.length > 0 && (
        <Section
          title="Guest nights don't match the calendar"
          count={guestNights.length}
          help="Keep yours if the calendar is missing direct bookings."
        >
          <GuestNightList items={guestNights} onChange={reloadAll} />
        </Section>
      )}

      {!!summary.data?.missing_receipts && (
        <section className="card">
          <Link className="section-toggle" to={scoped(`/files?year=${year}&missing=1`)}>
            <span>
              Receipts <span className="muted small">optional</span>
            </span>
            <span className="muted small">
              {summary.data.missing_receipts} {summary.data.missing_receipts === 1 ? "expense" : "expenses"} in {year}{" "}
              without one →
            </span>
          </Link>
        </section>
      )}

      {editing && <TxEditModal id={editing} onClose={() => setEditing(null)} onChanged={reloadAll} />}
    </div>
  );
}

function Section({
  title,
  count,
  help,
  children,
}: {
  title: string;
  count: number;
  help: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="section-head">
        <h2>
          {title} {count > 0 && <span className="nav-count inline">{count}</span>}
        </h2>
      </div>
      <p className="muted small">{help}</p>
      {children}
    </section>
  );
}

function EntryList({
  items,
  onOpen,
  children,
}: {
  items: Transaction[];
  onOpen: (id: number) => void;
  children: (tx: Transaction) => ReactNode;
}) {
  return (
    <ul className="todo-list">
      {items.map((tx) => (
        <li key={tx.id}>
          <button className="todo-main" onClick={() => onOpen(tx.id)}>
            <span className="todo-what">
              <strong>{tx.category}</strong>
              {(tx.subcategory || tx.vendor) && <span> · {tx.subcategory || tx.vendor}</span>}
              <span className="muted small"> · {fmtDate(tx.date)}</span>
            </span>
            {(tx.review_note || tx.description) && (
              <span className="todo-note">{tx.review_note ? `⚑ ${tx.review_note}` : tx.description}</span>
            )}
          </button>
          <Amount value={tx.amount} />
          <span className="todo-actions">{children(tx)}</span>
        </li>
      ))}
    </ul>
  );
}
