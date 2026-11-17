import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { Allocation, Transaction } from "../api.ts";
import TxForm, { type TxPrefill } from "../components/TxForm.tsx";
import TxEditModal from "../components/TxEditModal.tsx";
import { OutboxList } from "../components/Outbox.tsx";
import { fmtDate, thisMonth } from "../format.ts";
import { useToast, useScopedPath } from "../hooks.ts";
import { AllocationBadge, Amount } from "../lib.tsx";

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
            toast({ text: `Saved ${t.category} ${Math.abs(t.amount).toFixed(2)}`, kind: "ok" });
            if (!another) void navigate(scoped(back?.startsWith("/") ? back : "/transactions"));
          }}
          onQueued={(text) => toast({ text, kind: "ok" })}
        />
      </div>
      {added.length > 0 && (
        <section className="card">
          <h2>Added just now</h2>
          <ul className="tx-mini">
            {added.map((t) => (
              <li key={t.id}>
                <button className="row-btn" onClick={() => setEditing(t.id)}>
                  <span>{fmtDate(t.date)}</span>
                  <span>
                    {t.category}
                    {t.vendor && <small> · {t.vendor}</small>}
                  </span>
                  <AllocationBadge value={t.allocation} />
                  <Amount value={t.amount} />
                </button>
              </li>
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
          onChanged={() => setAdded([])}
        />
      )}
    </div>
  );
}
