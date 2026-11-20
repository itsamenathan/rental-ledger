import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api, type Recurring, type RecurringAlert, type Transaction, type TxList } from "../api.ts";
import { RecurringActions } from "../components/AttentionList.tsx";
import TodoRow from "../components/TodoRow.tsx";
import TxEditModal from "../components/TxEditModal.tsx";
import { CandidateList, GuestNightList } from "../components/OwnerStays.tsx";
import type { MonthCompare, StayCandidate } from "../owner-stays.ts";
import { fmtDate, money, monthTitle } from "../format.ts";
import { useApi, useSession, useToast, useProperty } from "../hooks.ts";
import { scopePath } from "../scope.ts";

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
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What's wrong with a recurring bill, without repeating its name (the row's title). */
function alertNote(a: RecurringAlert) {
  if (a.type === "missing")
    return `Nothing recorded for ${monthTitle(a.month)}. Usually about ${money(Math.abs(a.expected_amount))}.`;
  if (a.type === "duplicate") return `Recorded twice in ${monthTitle(a.month)}. Possible duplicate.`;
  const rest = a.message.startsWith(a.label) ? a.message.slice(a.label.length).trim() : a.message;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * Everything that needs a look, grouped by what you'd do about it. Every item uses the same row (TodoRow): what it's
 * about, what's wrong, and the buttons that fix it. The groups above the line are what the nav badge counts.
 */
export default function Todo() {
  const { key, qs: pq, path: scoped } = useProperty();
  const { overview, canWrite } = useSession();
  const flagged = useApi<TxList>(`transactions?needs_review=true&sort=date_asc&limit=500&${pq}`);
  const unallocated = useApi<TxList>(`transactions?kind=expense&allocation=none&sort=date_asc&limit=500&${pq}`);
  const rec = useApi<Recurring>(`recurring?${pq}`);
  const summary = useApi<TodoSummary>(`todo?${pq}`);
  const [editing, setEditing] = useState<number | null>(null);
  const toast = useToast();

  // Name each item's property only when the page covers several.
  const all = key === "all";
  const propName = (id: number) => (all ? overview.properties.find((p) => p.id === id)?.name : undefined);

  const occ = summary.data?.occupancy_items ?? [];
  const ownerStays = occ.flatMap((o) =>
    o.owner_stays.map((c) => ({ ...c, property_id: o.property_id, property: propName(o.property_id) })),
  );
  const guestNights = occ.flatMap((o) =>
    o.guest_nights.map((m) => ({ ...m, property_id: o.property_id, property: propName(o.property_id) })),
  );
  const managerMonths = summary.data?.manager_months ?? [];
  const alerts = rec.data?.alerts ?? [];
  const bills = alerts.filter((a) => a.level === "warning");
  const notes = alerts.filter((a) => a.level === "info");
  const seriesOf = (a: RecurringAlert) => rec.data?.series.find((x) => x.key === a.series_key);

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

  const total = summary.data?.total;
  const missingReceipts = summary.data?.missing_receipts ?? 0;

  return (
    <div className="page">
      <header className="page-head">
        <h1>To do</h1>
      </header>
      {!!total && <p className="muted small">{plural(total, "thing needs", "things need")} a look.</p>}
      {total === 0 && (
        <div className="card all-clear">
          <strong>✓ All caught up.</strong> Nothing is flagged, every expense has a tax treatment, and bills, manager
          statements and occupancy all check out.
        </div>
      )}

      {!!flagged.data?.total && (
        <Group
          title="Check flagged entries"
          count={flagged.data.total}
          hint="Fix anything that's wrong, then mark it OK."
        >
          {flagged.data.items.map((tx) => (
            <EntryRow key={tx.id} tx={tx} property={propName(tx.property_id)} onOpen={() => setEditing(tx.id)}>
              {canWrite && (
                <button
                  className="btn primary small"
                  onClick={() => void patch(tx.id, { needs_review: false }, "Marked OK")}
                >
                  Looks right
                </button>
              )}
            </EntryRow>
          ))}
        </Group>
      )}

      {!!unallocated.data?.total && (
        <Group
          title="Rental only, or the whole property?"
          count={unallocated.data.total}
          hint="Left out of the tax report until you pick. Rental only is deducted in full; whole property is split by rental days."
        >
          {unallocated.data.items.map((tx) => (
            <EntryRow key={tx.id} tx={tx} property={propName(tx.property_id)} onOpen={() => setEditing(tx.id)}>
              {canWrite && (
                <>
                  <button
                    className="btn small"
                    onClick={() => void patch(tx.id, { allocation: "direct" }, "Set to rental only")}
                  >
                    Rental only
                  </button>
                  <button
                    className="btn small"
                    onClick={() => void patch(tx.id, { allocation: "indirect" }, "Set to whole property")}
                  >
                    Whole property
                  </button>
                </>
              )}
            </EntryRow>
          ))}
        </Group>
      )}

      {bills.length > 0 && (
        <Group
          title="Recurring bills"
          count={bills.length}
          hint={
            <>
              Compared with what you usually pay. <Link to={scoped("/recurring")}>All recurring bills →</Link>
            </>
          }
        >
          {bills.map((a) => (
            <AlertRow
              key={`${a.series_key}|${a.type}|${a.month}`}
              alert={a}
              property={propName(seriesOf(a)?.property_id ?? 0)}
            >
              <RecurringActions alert={a} series={seriesOf(a)} onChanged={reloadAll} />
            </AlertRow>
          ))}
        </Group>
      )}

      {managerMonths.length > 0 && (
        <Group
          title="Manager statements"
          count={managerMonths.length}
          hint="The statement or invoice lists something the ledger doesn't have, or a difference nobody has explained."
        >
          {managerMonths.map((m) => (
            <TodoRow
              key={`${m.property_id}-${m.month}`}
              title={`${monthTitle(m.month)} statement`}
              property={propName(m.property_id)}
              note={
                [
                  m.to_add ? `${plural(m.to_add, "entry", "entries")} to add` : "",
                  m.to_check ? `${plural(m.to_check, "difference")} to explain` : "",
                ]
                  .filter(Boolean)
                  .join(", ") + "."
              }
            >
              <Link className="btn small primary" to={scopePath(String(m.property_id), `/statement/${m.month}`)}>
                Open statement
              </Link>
            </TodoRow>
          ))}
        </Group>
      )}

      {ownerStays.length > 0 && (
        <Group
          title="Did you stay here?"
          count={ownerStays.length}
          hint="The calendars were blocked with no guest. Your own stays count as personal days at tax time."
          list={false}
        >
          <CandidateList items={ownerStays} onChange={reloadAll} />
        </Group>
      )}

      {guestNights.length > 0 && (
        <Group
          title="Guest nights don't match the calendar"
          count={guestNights.length}
          hint="Keep your numbers if the calendar is missing direct bookings."
          list={false}
        >
          <GuestNightList items={guestNights} onChange={reloadAll} />
        </Group>
      )}

      {(notes.length > 0 || missingReceipts > 0) && (
        <Group title="Worth a look" hint="Not counted in the badge. Nothing here is necessarily wrong.">
          {notes.map((a) => (
            <AlertRow
              key={`${a.series_key}|${a.type}|${a.month}`}
              alert={a}
              property={propName(seriesOf(a)?.property_id ?? 0)}
            >
              <RecurringActions alert={a} series={seriesOf(a)} onChanged={reloadAll} />
            </AlertRow>
          ))}
          {missingReceipts > 0 && (
            <TodoRow
              title="Receipts"
              when={String(year)}
              note={`${plural(missingReceipts, "expense")} that should have a receipt and don't.`}
            >
              <Link className="btn small" to={scoped(`/files?year=${year}&missing=1`)}>
                See them
              </Link>
            </TodoRow>
          )}
        </Group>
      )}

      {editing && <TxEditModal id={editing} onClose={() => setEditing(null)} onChanged={reloadAll} />}
    </div>
  );
}

function Group({
  title,
  count,
  hint,
  list = true,
  children,
}: {
  title: string;
  count?: number;
  hint: ReactNode;
  /** false when the children bring their own list */
  list?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="section-head">
        <h2>
          {title} {!!count && <span className="nav-count inline">{count}</span>}
        </h2>
      </div>
      <p className="muted small">{hint}</p>
      {list ? <ul className="todo-list">{children}</ul> : children}
    </section>
  );
}

/** A ledger entry: category and vendor, its date, the note that explains why it's here. Click to edit. */
function EntryRow({
  tx,
  property,
  onOpen,
  children,
}: {
  tx: Transaction;
  property?: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  const who = tx.subcategory || tx.vendor;
  return (
    <TodoRow
      title={who ? `${tx.category} · ${who}` : tx.category}
      when={fmtDate(tx.date)}
      property={property}
      note={tx.review_note ? `⚑ ${tx.review_note}` : tx.description}
      amount={tx.amount}
      onOpen={onOpen}
    >
      {children}
    </TodoRow>
  );
}

function AlertRow({ alert: a, property, children }: { alert: RecurringAlert; property?: string; children: ReactNode }) {
  return (
    <TodoRow title={a.label} property={property} note={alertNote(a)}>
      {children}
    </TodoRow>
  );
}
