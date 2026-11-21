import { Children, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import {
  addLinkFor,
  api,
  qs,
  type Recurring,
  type RecurringAlert,
  type RecurringSeries,
  type Transaction,
  type TxList,
} from "../api.ts";
import TodoRow from "../components/TodoRow.tsx";
import TxEditModal from "../components/TxEditModal.tsx";
import { CandidateList, GuestNightList } from "../components/OwnerStays.tsx";
import type { MonthCompare, StayCandidate } from "../owner-stays.ts";
import { dateInMonth, fmtDate, money, monthTitle } from "../format.ts";
import { useApi, useSession, useToast, useProperty } from "../hooks.ts";
import { useDismissAlert } from "../recurring-dismiss.ts";
import { Amount } from "../lib.tsx";
import { scopePath } from "../scope.ts";
import { dueText } from "../state-tax.ts";

export interface TodoSummary {
  total: number;
  flagged: number;
  unallocated: number;
  recurring: number;
  recurring_notes: number;
  missing_receipts: number;
  receipts_year: number;
  tax_season: boolean;
  manager: number;
  manager_months: { property_id: number; month: string; to_add: number; to_check: number }[];
  occupancy: number;
  occupancy_items: {
    property_id: number;
    property: string;
    owner_stays: StayCandidate[];
    guest_nights: MonthCompare[];
  }[];
  state_tax: number;
  state_tax_items: {
    property_id: number;
    property: string;
    year: number;
    quarter: number;
    label: string;
    due_date: string;
    days_left: number;
    status: "open" | "overdue";
    gross: number;
    complete: boolean;
    location_id: string;
  }[];
}

/** Rows shown per group before "Show all". */
const SHOWN = 10;
/** "Mark all flagged OK" appears from this many flagged entries. */
const MARK_ALL_FROM = 3;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A link into one property's pages, whichever scope the To do page is showing. */
const at = (propertyId: number, to: string) => scopePath(String(propertyId), to);

/** What's wrong with a recurring bill, without repeating its name (the row's title). */
function alertNote(a: RecurringAlert) {
  // the server's second sentence: "It's usually about $79.99 around the 5th."
  const usual = a.message.split(". ").slice(1).join(". ");
  if (a.type === "missing") return `Nothing recorded for ${monthTitle(a.month)}. ${usual}`;
  if (a.type === "duplicate") return `Recorded twice in ${monthTitle(a.month)}. Delete one if it's a duplicate.`;
  const rest = a.message.startsWith(a.label) ? a.message.slice(a.label.length).trim() : a.message;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

type Act = (run: () => Promise<unknown>, text: string, undo?: () => Promise<unknown>) => Promise<void>;

/**
 * Everything that needs a look, grouped by the part of the app it belongs to. Every item uses the same row (TodoRow):
 * what it's about (the title opens it), what's wrong, and at most two buttons that fix it, with Undo in the toast.
 * Group counts add up to the nav badge (recurring notes and receipts aren't counted).
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

  // One row per entry, even when it's both flagged and missing its allocation.
  const entries = new Map<number, { tx: Transaction; flagged: boolean; unallocated: boolean }>();
  for (const tx of flagged.data?.items ?? []) entries.set(tx.id, { tx, flagged: true, unallocated: false });
  for (const tx of unallocated.data?.items ?? [])
    entries.set(tx.id, { tx, flagged: entries.has(tx.id), unallocated: true });
  const entryRows = [...entries.values()].sort((a, b) => a.tx.date.localeCompare(b.tx.date));
  const flaggedItems = flagged.data?.items ?? [];

  const occ = summary.data?.occupancy_items ?? [];
  const ownerStays = occ.flatMap((o) =>
    o.owner_stays.map((c) => ({ ...c, property_id: o.property_id, property: propName(o.property_id) })),
  );
  const guestNights = occ.flatMap((o) =>
    o.guest_nights.map((m) => ({ ...m, property_id: o.property_id, property: propName(o.property_id) })),
  );
  const managerMonths = summary.data?.manager_months ?? [];
  const stateTax = summary.data?.state_tax_items ?? [];
  const alerts = rec.data?.alerts ?? [];
  const bills = [...alerts.filter((a) => a.level === "warning"), ...alerts.filter((a) => a.level === "info")];
  const seriesOf = (a: RecurringAlert) => rec.data?.series.find((x) => x.key === a.series_key);

  const reloadAll = () => {
    void flagged.reload();
    void unallocated.reload();
    void rec.reload();
    void summary.reload();
    window.dispatchEvent(new Event("todo:changed"));
  };
  /** Run a change, then say so, with Undo in the toast when it can be undone. */
  const act: Act = async (run, text, undo) => {
    try {
      await run();
      toast({
        text,
        kind: "ok",
        action: undo && {
          label: "Undo",
          run: () => void undo().then(reloadAll, (e: Error) => toast({ text: e.message, kind: "error" })),
        },
      });
      reloadAll();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  const patch = (id: number, json: Record<string, unknown>) => api(`transactions/${id}`, { method: "PATCH", json });
  /** Put flags back with their notes (clearing a flag clears its note): one bulk update per distinct note. */
  const reflag = async (txs: Transaction[]) => {
    for (const note of new Set(txs.map((t) => t.review_note)))
      await api("transactions/bulk-update", {
        method: "POST",
        json: {
          ids: txs.filter((t) => t.review_note === note).map((t) => t.id),
          patch: { needs_review: true, review_note: note },
        },
      });
  };
  const setAllocation = (tx: Transaction, allocation: "direct" | "indirect") =>
    void act(
      () => patch(tx.id, { allocation }),
      allocation === "direct" ? "Set to rental only" : "Set to whole property",
      () => patch(tx.id, { allocation: null }),
    );
  const markAllOk = () => {
    const txs = flaggedItems;
    void act(
      () =>
        api("transactions/bulk-update", {
          method: "POST",
          json: { ids: txs.map((t) => t.id), patch: { needs_review: false } },
        }),
      `Marked ${plural(txs.length, "entry", "entries")} OK`,
      () => reflag(txs),
    );
  };

  const total = summary.data?.total;
  const receipts = summary.data?.tax_season && summary.data.missing_receipts > 0 ? summary.data : null;

  return (
    <div className="page">
      <header className="page-head">
        <h1>To do</h1>
      </header>
      {total === 0 && (
        <div className="card all-clear">
          <strong>✓ All caught up.</strong>
        </div>
      )}

      {entryRows.length > 0 && (
        <Group
          title="Transactions"
          count={entryRows.length}
          action={
            canWrite &&
            flaggedItems.length >= MARK_ALL_FROM && (
              <button className="btn small" onClick={markAllOk}>
                Mark all {flaggedItems.length} flagged OK
              </button>
            )
          }
        >
          {entryRows.map(({ tx, flagged: isFlagged, unallocated: isUnallocated }) => {
            const who = tx.subcategory || tx.vendor;
            const problems = [
              isFlagged ? (tx.review_note ? `Flagged: ${tx.review_note}` : "Flagged for review.") : "",
              isUnallocated ? "Rental only or whole property?" : "",
            ].filter(Boolean);
            return (
              <TodoRow
                key={tx.id}
                title={who ? `${tx.category} · ${who}` : tx.category}
                when={fmtDate(tx.date)}
                property={propName(tx.property_id)}
                note={
                  <>
                    {problems.join(" ")}
                    {tx.description && <span className="muted"> · {tx.description}</span>}
                  </>
                }
                amount={tx.amount}
                onOpen={() => setEditing(tx.id)}
              >
                {canWrite &&
                  // Allocation first; a flag that's left over gets "Looks right" once it's picked.
                  (isUnallocated ? (
                    <>
                      <button className="btn small" onClick={() => setAllocation(tx, "direct")}>
                        Rental only
                      </button>
                      <button className="btn small" onClick={() => setAllocation(tx, "indirect")}>
                        Whole property
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn primary small"
                      onClick={() =>
                        void act(
                          () => patch(tx.id, { needs_review: false }),
                          "Marked OK",
                          () => reflag([tx]),
                        )
                      }
                    >
                      Looks right
                    </button>
                  ))}
              </TodoRow>
            );
          })}
        </Group>
      )}

      {bills.length > 0 && (
        <Group title="Recurring bills" count={bills.filter((a) => a.level === "warning").length}>
          {bills.map((a) => (
            <BillRow
              key={`${a.series_key}|${a.type}|${a.month}`}
              alert={a}
              series={seriesOf(a)}
              property={propName(seriesOf(a)?.property_id ?? 0)}
              act={act}
              onChanged={reloadAll}
            />
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
              to={at(m.property_id, `/statement/${m.month}`)}
              note={
                [
                  m.to_add ? `${plural(m.to_add, "entry", "entries")} missing from the ledger` : "",
                  m.to_check ? `${plural(m.to_check, "difference")} to explain` : "",
                ]
                  .filter(Boolean)
                  .join(", ") + "."
              }
            >
              <Link className="btn small primary" to={at(m.property_id, `/statement/${m.month}`)}>
                Open statement
              </Link>
            </TodoRow>
          ))}
        </Group>
      )}

      {stateTax.length > 0 && (
        <Group title="State tax" count={stateTax.length}>
          {stateTax.map((s) => (
            <TodoRow
              key={`${s.property_id}-${s.year}-${s.quarter}`}
              title={`${s.label} sales tax return`}
              property={propName(s.property_id)}
              to={at(s.property_id, `/state-tax?year=${s.year}`)}
              note={
                <>
                  {dueText(s)}. Gross to file {money(s.gross)}.
                  {!s.complete && <span className="muted"> Some months have no manager statement saved.</span>}
                </>
              }
            >
              <Link className="btn small primary" to={at(s.property_id, `/state-tax?year=${s.year}`)}>
                File and pay
              </Link>
            </TodoRow>
          ))}
        </Group>
      )}

      {(ownerStays.length > 0 || guestNights.length > 0) && (
        <Group title="Occupancy" count={ownerStays.length + guestNights.length}>
          <CandidateList items={ownerStays} onChange={reloadAll} />
          <GuestNightList items={guestNights} onChange={reloadAll} />
        </Group>
      )}

      {receipts && (
        <Group title="Receipts">
          <TodoRow
            title={`${receipts.receipts_year} receipts`}
            note={`${plural(receipts.missing_receipts, "expense")} without a receipt.`}
            to={scoped(`/files?year=${receipts.receipts_year}&missing=1`)}
          >
            <Link className="btn small" to={scoped(`/files?year=${receipts.receipts_year}&missing=1`)}>
              See them
            </Link>
          </TodoRow>
        </Group>
      )}

      {editing && <TxEditModal id={editing} onClose={() => setEditing(null)} onChanged={reloadAll} />}
    </div>
  );
}

/** A card of To do rows; long lists show the first few with "Show all". */
function Group({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  /** a button for the whole group, next to the title */
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Counts direct children: CandidateList / GuestNightList are one child each (short lists, never cut).
  const rows = Children.toArray(children);
  const shown = open ? rows : rows.slice(0, SHOWN);
  return (
    <section className="card">
      <div className="section-head">
        <h2>
          {title} {!!count && <span className="nav-count inline">{count}</span>}
        </h2>
        {action}
      </div>
      <ul className="todo-list">{shown}</ul>
      {rows.length > SHOWN && (
        <button className="link small todo-more" onClick={() => setOpen((v) => !v)}>
          {open ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}

/**
 * A recurring-bill alert; the title opens the month. Missing: add it in one tap when the bill is always the same
 * amount (else the entry form, filled in), or "Nothing was due". Duplicate: the entries, each with Delete. Anything
 * else: "Looks right". Stopping tracking a bill is on the Recurring page.
 */
function BillRow({
  alert: a,
  series: s,
  property,
  act,
  onChanged,
}: {
  alert: RecurringAlert;
  series?: RecurringSeries;
  property?: string;
  act: Act;
  onChanged: () => void;
}) {
  const { canWrite } = useSession();
  const here = useLocation().pathname;
  const dismiss = useDismissAlert(onChanged);
  const link = (to: string) => (s ? at(s.property_id, to) : to);
  const date = s ? dateInMonth(a.month, s.expected_day) : "";

  const quickAdd = (s: RecurringSeries) => {
    let id = 0;
    void act(
      async () => {
        const tx = await api<Transaction>("transactions", {
          method: "POST",
          json: {
            property_id: s.property_id,
            date,
            amount: Math.abs(s.typical_amount) * (s.kind === "expense" ? -1 : 1),
            category_id: s.category_id,
            vendor: s.vendor,
            subcategory: s.subcategory,
            allocation: s.allocation ?? undefined,
          },
        });
        id = tx.id;
      },
      `Added ${a.label}, ${money(Math.abs(s.typical_amount))} on ${fmtDate(date)}`,
      () => api(`transactions/${id}`, { method: "DELETE" }),
    );
  };

  return (
    <TodoRow
      title={a.label}
      property={property}
      note={alertNote(a)}
      to={link(`/months/${a.month}`)}
      below={a.type === "duplicate" && s && a.ids?.length ? <DuplicateEntries alert={a} series={s} act={act} /> : null}
    >
      {canWrite && (
        <>
          {a.type === "missing" &&
            s &&
            (s.fixed_amount ? (
              <button className="btn small primary" onClick={() => quickAdd(s)}>
                Add {money(Math.abs(s.typical_amount))}
              </button>
            ) : (
              <Link className="btn small primary" to={link(addLinkFor(s, date, here))}>
                Add it
              </Link>
            ))}
          <button className="btn small ghost" onClick={() => void dismiss(a, false)}>
            {a.type === "missing" ? "Nothing was due" : a.type === "duplicate" ? "Not a duplicate" : "Looks right"}
          </button>
        </>
      )}
    </TodoRow>
  );
}

/** The entries behind a possible duplicate, each with Delete (to the trash, with Undo). */
function DuplicateEntries({ alert: a, series: s, act }: { alert: RecurringAlert; series: RecurringSeries; act: Act }) {
  const { canWrite } = useSession();
  const list = useApi<TxList>(
    `transactions${qs({
      month: a.month,
      category: s.category_id,
      vendor: s.vendor || undefined,
      property_id: s.property_id,
      sort: "date_asc",
      limit: 50,
    })}`,
  );
  const items = (list.data?.items ?? []).filter((t) => a.ids?.includes(t.id));
  if (!items.length) return null;
  return (
    <ul className="todo-sub">
      {items.map((t) => (
        <li key={t.id}>
          <span>
            {fmtDate(t.date)}
            {(t.description || t.account) && <span className="muted"> · {t.description || t.account}</span>}
          </span>
          <Amount value={t.amount} />
          {canWrite ? (
            <button
              className="btn small"
              onClick={() =>
                void act(
                  () => api(`transactions/${t.id}`, { method: "DELETE" }),
                  `Deleted the ${fmtDate(t.date)} entry`,
                  () => api(`transactions/${t.id}/restore`, { method: "POST" }),
                )
              }
            >
              Delete
            </button>
          ) : (
            <span />
          )}
        </li>
      ))}
    </ul>
  );
}
