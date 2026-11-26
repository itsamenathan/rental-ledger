import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { qs, type Allocation, type Transaction, type TxList } from "../api.ts";
import TxForm, { type TxPrefill } from "../components/TxForm.tsx";
import TxEditModal from "../components/TxEditModal.tsx";
import { OutboxList } from "../components/Outbox.tsx";
import { TxRow, type RowCtx } from "../components/TxRows.tsx";
import { money, thisMonth } from "../format.ts";
import { txParts } from "../month-view.ts";
import { useApi, usePendingByEntry, useSession, useToast, useScopedPath } from "../hooks.ts";

export default function AddEntry() {
  const scoped = useScopedPath();
  const [added, setAdded] = useState<Transaction[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const toast = useToast();
  const navigate = useNavigate();
  // Links like /add?category_id=3&amount=69.95&date=2026-08-01 (from a missing recurring bill) pre-fill the form.
  const [params] = useSearchParams();
  const num = (k: string) => (params.get(k) ? Number(params.get(k)) : undefined);
  const prefill: TxPrefill = {
    kind: (params.get("kind") as TxPrefill["kind"]) ?? undefined,
    amount: num("amount"),
    date: params.get("date") ?? undefined,
    category_id: num("category_id"),
    vendor: params.get("vendor") ?? undefined,
    subcategory: params.get("subcategory") ?? undefined,
    allocation: params.has("allocation") ? ((params.get("allocation") || null) as Allocation) : undefined,
    description: params.get("description") ?? undefined,
  };
  const back = params.get("back");
  // The saved rows read back from the list (it adds needs_receipt and shows later edits), newest first. While it
  // loads, the copy the save returned stands in; once it has answered, an entry it no longer has was deleted.
  const list = useApi<TxList>(
    added.length ? `transactions${qs({ ids: added.map((t) => t.id).join(","), limit: 500 })}` : null,
  );
  const fresh = new Map(list.data?.items.map((t) => [t.id, t]));
  const settled = list.data && !list.loading;
  const addedRows = added.flatMap((t) => {
    const row = fresh.get(t.id);
    return row ? [row] : settled ? [] : [t];
  });
  const { canWrite } = useSession();
  const pending = usePendingByEntry();
  const ctx: RowCtx = {
    canWrite,
    showProperty: false,
    onOpen: setEditing,
    onChanged: () => void list.reload(),
    pending,
  };

  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>Add entry</h1>
        <span className="head-actions">
          <Link to={scoped(`/months/${thisMonth()}?record=1`)} className="link">
            Record this month's bills
          </Link>
          <Link to={scoped("/import")} className="link">
            Import a CSV
          </Link>
        </span>
      </header>
      <div className="card">
        <TxForm
          key={params.toString()}
          prefill={prefill}
          compact
          onSaved={(t, { another }) => {
            setAdded((a) => [t, ...a]);
            toast({ text: `Saved ${txParts(t).main} ${money(Math.abs(t.amount))}`, kind: "ok" });
            if (!another) void navigate(scoped(back?.startsWith("/") ? back : "/transactions"));
          }}
          onQueued={(text) => toast({ text, kind: "ok" })}
        />
      </div>
      {addedRows.length > 0 && (
        <section className="card">
          <h2>Added just now</h2>
          <ul className="tx-mini tx-flat">
            {addedRows.map((t) => (
              <TxRow key={t.id} t={t} ctx={ctx} withCategory />
            ))}
          </ul>
        </section>
      )}
      <OutboxList />
      {editing && (
        <TxEditModal
          id={editing}
          initial={added.find((t) => t.id === editing)}
          onClose={() => setEditing(null)}
          onChanged={() => void list.reload()}
        />
      )}
    </div>
  );
}
