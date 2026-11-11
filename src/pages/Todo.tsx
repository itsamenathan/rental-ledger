import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api, type Recurring, type Transaction, type TxList } from "../api.ts";
import AttentionList from "../components/AttentionList.tsx";
import TxEditModal from "../components/TxEditModal.tsx";
import { fmtDate } from "../format.ts";
import { useApi, useSession, useToast } from "../hooks.ts";
import { Amount } from "../lib.tsx";

export interface TodoSummary {
  total: number;
  flagged: number;
  unallocated: number;
  recurring: number;
  recurring_notes: number;
  missing_receipts: number;
}

const year = new Date().getFullYear();

/** One place for everything that needs a look: flagged entries, missing tax treatment, recurring-bill alerts. */
export default function Todo() {
  const flagged = useApi<TxList>("transactions?needs_review=true&sort=date_asc&limit=500");
  const unallocated = useApi<TxList>("transactions?kind=expense&allocation=none&sort=date_asc&limit=500");
  const rec = useApi<Recurring>("recurring");
  const [showReceipts, setShowReceipts] = useState(false);
  const receipts = useApi<TxList>(
    showReceipts
      ? `transactions?kind=expense&has_attachment=false&min_amount=75&year=${year}&sort=amount_asc&limit=500`
      : null,
  );
  const receiptCount = useApi<TxList>(
    `transactions?kind=expense&has_attachment=false&min_amount=75&year=${year}&limit=1`,
  );
  const [editing, setEditing] = useState<number | null>(null);
  const { canWrite } = useSession();
  const toast = useToast();

  const reloadAll = () => {
    void flagged.reload();
    void unallocated.reload();
    void rec.reload();
    void receiptCount.reload();
    if (showReceipts) void receipts.reload();
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
  const nothing = loaded && !flagged.data!.total && !unallocated.data!.total && !rec.data!.alerts.length;

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
              <Link to="/recurring">See everything it tracks →</Link>
            </>
          }
        >
          <AttentionList alerts={[...warnings, ...notes]} series={rec.data.series} onChanged={reloadAll} />
        </Section>
      )}

      <section className="card">
        <button className="section-toggle" onClick={() => setShowReceipts((v) => !v)} aria-expanded={showReceipts}>
          <span>
            {showReceipts ? "▾" : "▸"} Receipts <span className="muted small">optional</span>
          </span>
          <span className="muted small">
            {receiptCount.data ? `${receiptCount.data.total} expenses of $75+ in ${year} without one` : ""}
          </span>
        </button>
        {showReceipts && receipts.data && (
          <>
            <p className="muted small">
              Not required, but handy if your preparer asks. Open an entry to attach a photo or PDF.
            </p>
            <EntryList items={receipts.data.items} onOpen={setEditing}>
              {(tx) =>
                canWrite && (
                  <button className="btn small" onClick={() => setEditing(tx.id)}>
                    Attach
                  </button>
                )
              }
            </EntryList>
          </>
        )}
      </section>

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
