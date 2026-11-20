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
 * Everything that needs a look, grouped by the part of the app it belongs to. Every item uses the same row (TodoRow):
 * what it's about, what's wrong, and the buttons that fix it. Group counts add up to the nav badge (recurring notes
 * and receipts aren't counted).
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
          <strong>✓ All caught up.</strong>
        </div>
      )}

      {(!!flagged.data?.total || !!unallocated.data?.total) && (
        <Group title="Transactions" count={(flagged.data?.total ?? 0) + (unallocated.data?.total ?? 0)}>
          {flagged.data?.items.map((tx) => (
            <EntryRow
              key={`f${tx.id}`}
              tx={tx}
              problem={tx.review_note ? `Flagged: ${tx.review_note}` : "Flagged for review"}
              property={propName(tx.property_id)}
              onOpen={() => setEditing(tx.id)}
            >
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
          {unallocated.data?.items.map((tx) => (
            <EntryRow
              key={`u${tx.id}`}
              tx={tx}
              problem="Rental only or whole property?"
              property={propName(tx.property_id)}
              onOpen={() => setEditing(tx.id)}
            >
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

      {alerts.length > 0 && (
        <Group title="Recurring bills" count={bills.length}>
          {[...bills, ...notes].map((a) => (
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
        <Group title="Manager statements" count={managerMonths.length}>
          {managerMonths.map((m) => (
            <TodoRow
              key={`${m.property_id}-${m.month}`}
              title={`${monthTitle(m.month)} statement`}
              property={propName(m.property_id)}
              note={
                [
                  m.to_add ? `${plural(m.to_add, "entry", "entries")} missing from the ledger` : "",
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

      {(ownerStays.length > 0 || guestNights.length > 0) && (
        <Group title="Occupancy" count={ownerStays.length + guestNights.length} list={false}>
          {ownerStays.length > 0 && <CandidateList items={ownerStays} onChange={reloadAll} />}
          {guestNights.length > 0 && <GuestNightList items={guestNights} onChange={reloadAll} />}
        </Group>
      )}

      {missingReceipts > 0 && (
        <Group title="Receipts">
          <TodoRow title={`${year} receipts`} note={`${plural(missingReceipts, "expense")} without a receipt.`}>
            <Link className="btn small" to={scoped(`/files?year=${year}&missing=1`)}>
              See them
            </Link>
          </TodoRow>
        </Group>
      )}

      {editing && <TxEditModal id={editing} onClose={() => setEditing(null)} onChanged={reloadAll} />}
    </div>
  );
}

function Group({
  title,
  count,
  list = true,
  children,
}: {
  title: string;
  count?: number;
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
      {list ? <ul className="todo-list">{children}</ul> : children}
    </section>
  );
}

/** A ledger entry: category and vendor, its date, what's wrong with it (and its description). Click to edit. */
function EntryRow({
  tx,
  problem,
  property,
  onOpen,
  children,
}: {
  tx: Transaction;
  problem: string;
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
      note={
        <>
          {problem}
          {tx.description && <span className="muted"> · {tx.description}</span>}
        </>
      }
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
