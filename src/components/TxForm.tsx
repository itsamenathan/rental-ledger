import { useMemo, useRef, useState, type FormEvent } from "react";
import { api, uploadAttachments, type Allocation, type Attachment, type Transaction } from "../api.ts";
import { money, today } from "../format.ts";
import { useApi, useSession } from "../hooks.ts";

interface Suggestions {
  vendors: { vendor: string; category: string; subcategory: string; allocation: Allocation; uses: number }[];
  subcategories: { category: string; subcategory: string; uses: number }[];
  accounts: { account: string; uses: number }[];
  category_use: { category_id: number; uses: number }[];
}

export interface TxPrefill {
  kind?: "expense" | "income";
  amount?: number;
  date?: string;
  category_id?: number;
  vendor?: string;
  subcategory?: string;
  allocation?: Allocation;
  description?: string;
}

interface Props {
  existing?: Transaction & { attachments?: Attachment[] };
  /** Starting values for a new entry (ignored when editing) */
  prefill?: TxPrefill;
  onSaved: (t: Transaction, opts: { another: boolean }) => void;
  onDelete?: () => void;
  compact?: boolean;
}

export default function TxForm({ existing, prefill = {}, onSaved, onDelete, compact }: Props) {
  const { overview } = useSession();
  const sugg = useApi<Suggestions>("suggestions");
  const activeProps = overview.properties.filter((p) => !p.archived);

  const [kind, setKind] = useState<"expense" | "income">(existing?.kind ?? prefill.kind ?? "expense");
  const [amount, setAmount] = useState(
    existing ? String(Math.abs(existing.amount)) : prefill.amount ? Math.abs(prefill.amount).toFixed(2) : "",
  );
  const [date, setDate] = useState(existing?.date ?? prefill.date ?? today());
  const [categoryId, setCategoryId] = useState<number | null>(existing?.category_id ?? prefill.category_id ?? null);
  const [vendor, setVendor] = useState(existing?.vendor ?? prefill.vendor ?? "");
  const [subcategory, setSubcategory] = useState(existing?.subcategory ?? prefill.subcategory ?? "");
  const [allocation, setAllocation] = useState<Allocation>(existing?.allocation ?? prefill.allocation ?? null);
  const [allocTouched, setAllocTouched] = useState(!!existing || prefill.allocation !== undefined);
  const [description, setDescription] = useState(existing?.description ?? prefill.description ?? "");
  const [account, setAccount] = useState(existing?.account ?? "");
  const [propertyId, setPropertyId] = useState<number>(existing?.property_id ?? activeProps[0]?.id ?? 0);
  const [refund, setRefund] = useState(
    existing ? (existing.kind === "expense" ? existing.amount > 0 : existing.amount < 0) : false,
  );
  const [needsReview, setNeedsReview] = useState(existing?.needs_review ?? false);
  const [reviewNote, setReviewNote] = useState(existing?.review_note ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>(existing?.attachments ?? []);
  const [showMore, setShowMore] = useState((!!existing && !compact) || !!prefill.vendor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anotherRef = useRef(false);
  const amountRef = useRef<HTMLInputElement>(null);

  const categories = overview.categories.filter((c) => c.kind === kind && (!c.archived || c.id === categoryId));
  // Most-used categories first, as quick-pick chips.
  const ranked = useMemo(() => {
    const use = new Map(sugg.data?.category_use.map((u) => [u.category_id, u.uses]));
    return [...categories].sort((a, b) => (use.get(b.id) ?? 0) - (use.get(a.id) ?? 0) || a.sort_order - b.sort_order);
  }, [categories, sugg.data]);
  const category = overview.categories.find((c) => c.id === categoryId);
  const subOptions =
    sugg.data?.subcategories.filter((s) => s.category === category?.name).map((s) => s.subcategory) ?? [];

  const pickCategory = (id: number) => {
    setCategoryId(id);
    const c = overview.categories.find((x) => x.id === id);
    if (c && !allocTouched) setAllocation(c.kind === "expense" ? c.default_allocation : null);
  };

  const pickVendor = (v: string) => {
    setVendor(v);
    const hit = sugg.data?.vendors.find((x) => x.vendor.toLowerCase() === v.toLowerCase());
    if (hit && !existing) {
      const c = overview.categories.find((x) => x.name === hit.category);
      if (c && c.kind === kind && categoryId == null) {
        setCategoryId(c.id);
        if (!allocTouched) setAllocation(hit.allocation);
        if (!subcategory) setSubcategory(hit.subcategory);
      }
    }
  };

  const switchKind = (k: "expense" | "income") => {
    setKind(k);
    if (category && category.kind !== k) setCategoryId(null);
    if (k === "income") setAllocation(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = Number(amount.replace(/[$,\s]/g, ""));
    if (!value || value <= 0) return setError("Enter an amount greater than zero");
    if (!categoryId) return setError("Pick a category");
    const sign = (kind === "expense" ? -1 : 1) * (refund ? -1 : 1);
    const payload = {
      property_id: propertyId,
      date,
      amount: sign * value,
      category_id: categoryId,
      vendor,
      subcategory,
      allocation: kind === "income" ? null : allocation,
      description,
      account,
      refund,
      needs_review: needsReview,
      review_note: needsReview ? reviewNote : "",
    };
    setBusy(true);
    try {
      const saved = existing
        ? await api<Transaction>(`transactions/${existing.id}`, { method: "PATCH", json: payload })
        : await api<Transaction>("transactions", { method: "POST", json: payload });
      if (files.length) await uploadAttachments(saved.id, files);
      onSaved({ ...saved, attachment_count: saved.attachment_count + files.length }, { another: anotherRef.current });
      if (anotherRef.current) {
        setAmount("");
        setDescription("");
        setFiles([]);
        setRefund(false);
        setNeedsReview(false);
        setReviewNote("");
        amountRef.current?.focus();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeAttachment = async (id: number) => {
    if (!confirm("Delete this attachment?")) return;
    await api(`attachments/${id}`, { method: "DELETE" });
    setAttachments((a) => a.filter((x) => x.id !== id));
  };

  return (
    <form className="tx-form" onSubmit={submit}>
      {error && <div className="alert error">{error}</div>}

      <div className="segmented kind-toggle" role="radiogroup" aria-label="Type">
        <button
          type="button"
          role="radio"
          aria-checked={kind === "expense"}
          className={kind === "expense" ? "on" : ""}
          onClick={() => switchKind("expense")}
        >
          Expense
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={kind === "income"}
          className={kind === "income" ? "on" : ""}
          onClick={() => switchKind("income")}
        >
          Income
        </button>
      </div>

      <div className="row-2">
        <label className="amount-field">
          Amount
          <div className="input-prefix">
            <span>$</span>
            <input
              ref={amountRef}
              inputMode="decimal"
              autoFocus={!existing}
              required
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-describedby="amount-hint"
            />
          </div>
          {refund && (
            <small id="amount-hint" className="hint">
              Recorded as {money((kind === "expense" ? 1 : -1) * (Number(amount) || 0))} (
              {kind === "expense" ? "refund" : "reversal"})
            </small>
          )}
        </label>
        <label>
          Date
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>

      <fieldset className="field">
        <legend>Category</legend>
        <div className="chips">
          {ranked.slice(0, compact ? 8 : 12).map((c) => (
            <button
              type="button"
              key={c.id}
              className={`chip ${c.id === categoryId ? "on" : ""}`}
              onClick={() => pickCategory(c.id)}
              aria-pressed={c.id === categoryId}
            >
              {c.name}
            </button>
          ))}
          {ranked.length > (compact ? 8 : 12) && (
            <select
              value={ranked.slice(compact ? 8 : 12).some((c) => c.id === categoryId) ? categoryId! : ""}
              onChange={(e) => pickCategory(Number(e.target.value))}
              aria-label="More categories"
            >
              <option value="">More…</option>
              {ranked.slice(compact ? 8 : 12).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </fieldset>

      {category && (
        <fieldset className="field">
          <legend>
            {category.name} type <span className="optional">optional</span>
          </legend>
          <div className="chips">
            {subOptions.map((s) => (
              <button
                type="button"
                key={s}
                className={`chip small ${s === subcategory ? "on" : ""}`}
                aria-pressed={s === subcategory}
                onClick={() => setSubcategory(s === subcategory ? "" : s)}
              >
                {s}
              </button>
            ))}
            <input
              className="chip-input"
              value={subOptions.includes(subcategory) ? "" : subcategory}
              onChange={(e) => setSubcategory(e.target.value)}
              placeholder={
                subOptions.length
                  ? "Other…"
                  : kind === "income"
                    ? "e.g. Cleaning fee, Pet fee"
                    : "e.g. Electric, Hot tub"
              }
              aria-label="Subcategory"
            />
          </div>
        </fieldset>
      )}

      <label>
        <span>
          Note <span className="optional">optional</span>
        </span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was it for?" />
      </label>

      <label className="file-field">
        <span>
          Receipt <span className="optional">optional</span>
        </span>
        <input
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          multiple
          onChange={(e) => setFiles([...(e.target.files ?? [])])}
        />
        {files.length > 0 && <small className="hint">{files.map((f) => f.name).join(", ")}</small>}
      </label>
      {attachments.length > 0 && (
        <ul className="attachments">
          {attachments.map((a) => (
            <li key={a.id}>
              <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">
                {a.content_type.startsWith("image/") ? <img src={`/api/attachments/${a.id}`} alt="" /> : "📄"}{" "}
                {a.filename}
              </a>
              <button type="button" className="link danger" onClick={() => void removeAttachment(a.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {kind === "expense" && category && (
        <TaxLine
          value={allocation}
          isDefault={allocation === category.default_allocation}
          onChange={(a) => {
            setAllocation(a);
            setAllocTouched(true);
          }}
        />
      )}

      {!showMore ? (
        <button type="button" className="link small more-toggle" onClick={() => setShowMore(true)}>
          More options (paid to, account, refund, flag for review)
        </button>
      ) : (
        <div className="more">
          <label>
            <span>
              {kind === "expense" ? "Paid to" : "Paid by"} <span className="optional">optional</span>
            </span>
            <input
              list="vendor-list"
              value={vendor}
              onChange={(e) => pickVendor(e.target.value)}
              placeholder={kind === "expense" ? "e.g. Home Depot" : "e.g. Airbnb"}
            />
            <datalist id="vendor-list">
              {sugg.data?.vendors.map((v) => (
                <option key={v.vendor} value={v.vendor} />
              ))}
              {kind === "income" && ["Airbnb", "VRBO", "Direct booking"].map((v) => <option key={v} value={v} />)}
            </datalist>
          </label>
          <label>
            <span>
              {kind === "expense" ? "Paid from" : "Deposited to"} <span className="optional">optional</span>
            </span>
            <input
              list="account-list"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="e.g. Checking"
            />
            <datalist id="account-list">
              {sugg.data?.accounts.map((a) => (
                <option key={a.account} value={a.account} />
              ))}
            </datalist>
          </label>
          {activeProps.length > 1 && (
            <label>
              Property
              <select value={propertyId} onChange={(e) => setPropertyId(Number(e.target.value))}>
                {overview.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
            {kind === "expense"
              ? "This is a refund or reimbursement (money back)"
              : "This is a reversal / chargeback (money out)"}
          </label>
          <label className="check">
            <input type="checkbox" checked={needsReview} onChange={(e) => setNeedsReview(e.target.checked)} />
            Needs review
          </label>
          {needsReview && (
            <input
              placeholder="What needs checking?"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
            />
          )}
          {existing && (
            <p className="meta">
              #{existing.id} · source {existing.source}
              {existing.created_by ? ` · added by ${existing.created_by}` : ""}
              {existing.updated_by ? ` · last edited by ${existing.updated_by}` : ""}
            </p>
          )}
        </div>
      )}

      <div className="form-actions">
        {onDelete && (
          <button type="button" className="btn danger-outline" onClick={onDelete}>
            Delete
          </button>
        )}
        <span className="spacer" />
        {!existing && (
          <button className="btn" disabled={busy} onClick={() => (anotherRef.current = true)}>
            Save &amp; add another
          </button>
        )}
        <button className="btn primary" disabled={busy} onClick={() => (anotherRef.current = false)}>
          {busy ? "Saving…" : existing ? "Save changes" : "Save"}
        </button>
      </div>
    </form>
  );
}

const TAX_TEXT = {
  direct: "Direct: only for the rental (guests, cleaning, booking fees), so it's deducted in full.",
  indirect:
    "Indirect: benefits the whole property (mortgage, insurance, property tax), so it's split by rental vs personal days.",
};

/** Direct/indirect, shown as a sentence set from the category, with a one-click switch. */
function TaxLine({
  value,
  isDefault,
  onChange,
}: {
  value: Allocation;
  isDefault: boolean;
  onChange: (a: "direct" | "indirect") => void;
}) {
  if (!value)
    return (
      <div className="tax-line">
        <span>Is this only for the rental, or for the whole property?</span>
        <span className="tax-choices">
          <button type="button" className="btn small" onClick={() => onChange("direct")}>
            Only the rental (direct)
          </button>
          <button type="button" className="btn small" onClick={() => onChange("indirect")}>
            Whole property (indirect)
          </button>
        </span>
      </div>
    );
  const other = value === "direct" ? "indirect" : "direct";
  return (
    <div className="tax-line">
      <span>
        <strong>Taxes:</strong> {TAX_TEXT[value]}
        {isDefault && <span className="muted"> (usual for this category)</span>}
      </span>
      <button type="button" className="link small" onClick={() => onChange(other)}>
        Make it {other}
      </button>
    </div>
  );
}
