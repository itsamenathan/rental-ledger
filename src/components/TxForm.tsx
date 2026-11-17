import { useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Allocation, type Attachment, type Transaction } from "../api.ts";
import { money, today } from "../format.ts";
import { useApi, useSession, useProperty } from "../hooks.ts";
import {
  asText,
  editQueued,
  enqueue,
  enqueueUpdate,
  isUnreachable,
  newClientId,
  SAVE_TIMEOUT_MS,
  timeout,
  toOutboxFiles,
  uploadOrQueue,
  type OutboxEntry,
  type OutboxFile,
} from "../outbox.ts";
import { useReceiptUploads } from "../receipt-uploads.ts";
import ReceiptPicker from "./ReceiptPicker.tsx";

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
  /** Work was kept on this device to send later (no connection), or a waiting entry was changed. */
  onQueued?: (message: string) => void;
  /** Edit a new entry that is still waiting on this device (not yet on the server). */
  queued?: OutboxEntry;
  onDelete?: () => void;
  compact?: boolean;
}

/** Fields the form edits, as sent to the server (also what an offline edit compares against). */
type Seed = Pick<
  Transaction,
  | "kind"
  | "amount"
  | "date"
  | "category_id"
  | "vendor"
  | "subcategory"
  | "allocation"
  | "description"
  | "account"
  | "property_id"
  | "needs_review"
  | "review_note"
>;

/** A waiting entry's saved payload, in the shape the form starts from. */
function seedFromPayload(p: Record<string, unknown>, kindOf: (categoryId: number) => "income" | "expense"): Seed {
  return {
    kind: kindOf(Number(p.category_id)),
    amount: Number(p.amount),
    date: asText(p.date),
    category_id: Number(p.category_id),
    vendor: asText(p.vendor),
    subcategory: asText(p.subcategory),
    allocation: (p.allocation ?? null) as Allocation,
    description: asText(p.description),
    account: asText(p.account),
    property_id: Number(p.property_id),
    needs_review: !!p.needs_review,
    review_note: asText(p.review_note),
  };
}

const PATCH_KEYS = [
  "property_id",
  "date",
  "amount",
  "category_id",
  "vendor",
  "subcategory",
  "allocation",
  "description",
  "account",
  "needs_review",
  "review_note",
] as const;

/** Only the fields that differ from the entry as loaded, so a later "keep mine" can't undo other changes. */
function changedFields(before: Seed, payload: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  for (const k of PATCH_KEYS) {
    const was = before[k];
    const now = payload[k];
    const same = k === "amount" ? Math.round(Number(was) * 100) === Math.round(Number(now) * 100) : was === now;
    if (!same) patch[k] = now;
  }
  if ("amount" in patch || "category_id" in patch) patch.refund = payload.refund;
  return patch;
}

export default function TxForm({ existing, queued, prefill = {}, onSaved, onQueued, onDelete, compact }: Props) {
  const { overview, user } = useSession();
  const sugg = useApi<Suggestions>("suggestions");
  const currentProperty = useProperty().single;
  const [seed] = useState<Seed | undefined>(() =>
    existing
      ? existing
      : queued?.payload
        ? seedFromPayload(queued.payload, (id) => overview.categories.find((c) => c.id === id)?.kind ?? "expense")
        : undefined,
  );

  const [kind, setKind] = useState<"expense" | "income">(seed?.kind ?? prefill.kind ?? "expense");
  const [amount, setAmount] = useState(
    seed ? String(Math.abs(seed.amount)) : prefill.amount ? Math.abs(prefill.amount).toFixed(2) : "",
  );
  const [date, setDate] = useState(seed?.date ?? prefill.date ?? today());
  const [categoryId, setCategoryId] = useState<number | null>(seed?.category_id ?? prefill.category_id ?? null);
  const [vendor, setVendor] = useState(seed?.vendor ?? prefill.vendor ?? "");
  const [subcategory, setSubcategory] = useState(seed?.subcategory ?? prefill.subcategory ?? "");
  const [allocation, setAllocation] = useState<Allocation>(seed?.allocation ?? prefill.allocation ?? null);
  const [allocTouched, setAllocTouched] = useState(!!seed || prefill.allocation !== undefined);
  const [description, setDescription] = useState(seed?.description ?? prefill.description ?? "");
  const [account, setAccount] = useState(seed?.account ?? "");
  const [propertyId, setPropertyId] = useState<number>(seed?.property_id ?? currentProperty);
  const [refund, setRefund] = useState(seed ? (seed.kind === "expense" ? seed.amount > 0 : seed.amount < 0) : false);
  const [needsReview, setNeedsReview] = useState(seed?.needs_review ?? false);
  const [reviewNote, setReviewNote] = useState(seed?.review_note ?? "");
  const receipts = useReceiptUploads({ stage: !queued });
  const [attachments, setAttachments] = useState<Attachment[]>(existing?.attachments ?? []);
  const [showMore, setShowMore] = useState((!!seed && !compact) || !!prefill.vendor);
  const [queuedFiles, setQueuedFiles] = useState<OutboxFile[]>(queued?.files ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anotherRef = useRef(false);
  // Idempotency key for this entry: kept across retries of the same form (so a resubmit after a lost response or a
  // refused receipt returns the entry already saved) and renewed once it has been saved or queued.
  const clientIdRef = useRef(newClientId());
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
    if (hit && !seed) {
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
    const label = `${category?.name ?? "Entry"}${vendor ? ` (${vendor})` : ""} · ${money(sign * value)}`;
    const resetForAnother = () => {
      clientIdRef.current = newClientId();
      setAmount("");
      setDescription("");
      setRefund(false);
      setNeedsReview(false);
      setReviewNote("");
      amountRef.current?.focus();
    };
    setBusy(true);
    try {
      // Receipts upload as soon as they're picked; a save made while one is still going waits for it.
      const picked = await receipts.settle();
      if (picked.failed.length)
        throw new Error(
          `${picked.failed[0]!.file.name} couldn't be uploaded: ${picked.failed[0]!.error}. Remove it or try again.`,
        );
      if (queued) {
        // Still on this device: change what will be sent.
        const kept = [...queuedFiles, ...(await toOutboxFiles(picked.allFiles))];
        await editQueued(queued.id, { payload, files: kept, label, date });
        receipts.clear({ saved: true });
        onQueued?.(`Updated ${label} (still waiting to sync)`);
        return;
      }
      // Kept for the outbox if the save can't reach the server (staged uploads are then dropped on the server).
      const files = picked.allFiles;
      const upload_ids = picked.uploadIds.length ? picked.uploadIds : undefined;
      let saved: Transaction;
      try {
        saved = existing
          ? await api<Transaction>(`transactions/${existing.id}`, {
              method: "PATCH",
              // The form may show a saved (offline) copy: never overwrite a newer version with it.
              json: { ...payload, upload_ids, expected_updated_at: existing.updated_at },
              signal: timeout(SAVE_TIMEOUT_MS),
            })
          : await api<Transaction>("transactions", {
              method: "POST",
              json: { ...payload, upload_ids, client_id: clientIdRef.current },
              signal: timeout(SAVE_TIMEOUT_MS), // a weak signal queues the entry instead of hanging
            });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409)
          throw new Error(
            "This entry was changed since you opened it. Close and reopen it to see the latest, then make your change again.",
          );
        if (!isUnreachable(err)) throw err;
        if (!existing) {
          await enqueue({ id: clientIdRef.current, userId: user.id, payload, files, label, date });
          receipts.clear({ saved: false });
          resetForAnother();
          onQueued?.(`No connection: ${label} is saved on this device and syncs when you're back online`);
          return;
        }
        const { attachments: _a, ...base } = existing;
        const patch = changedFields(existing, payload);
        if (!Object.keys(patch).length && !files.length)
          throw new Error("Can't reach the server, and nothing changed.");
        await enqueueUpdate({ userId: user.id, base, patch, files, label });
        receipts.clear({ saved: false });
        onQueued?.(`No connection: your changes to ${label} are saved on this device and sync when you're back online`);
        return;
      }
      // The uploaded receipts were attached with the save (saved.attachment_count includes them).
      receipts.clear({ saved: true });
      // Receipts picked while the connection was down go up now, or wait on this device.
      const local = picked.localFiles;
      let uploaded = local.length;
      if (local.length) {
        try {
          if ((await uploadOrQueue(user.id, { id: saved.id, date, label }, local)) === "queued") {
            onQueued?.("Entry saved; the receipt is kept on this device and uploads when you reconnect");
            uploaded = 0;
          }
        } catch (err) {
          // The entry is saved. Saving again returns it (same client_id); add the receipt to it from Transactions.
          throw new Error(
            `The entry was saved, but the receipt was refused: ${(err as Error).message}. Open the entry from Transactions to attach another file.`,
          );
        }
      }
      onSaved({ ...saved, attachment_count: saved.attachment_count + uploaded }, { another: anotherRef.current });
      clientIdRef.current = newClientId();
      if (anotherRef.current) resetForAnother();
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
              autoFocus={!seed}
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

      <ReceiptPicker
        uploads={receipts}
        attachments={attachments}
        onRemoveAttachment={(id) => void removeAttachment(id)}
        queuedFiles={queuedFiles}
        onRemoveQueued={(i) => setQueuedFiles((q) => q.filter((_, j) => j !== i))}
      />

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
          {overview.properties.filter((p) => !p.archived).length > 1 && (
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
        {!seed && (
          <button className="btn" disabled={busy} onClick={() => (anotherRef.current = true)}>
            Save &amp; add another
          </button>
        )}
        <button className="btn primary" disabled={busy} onClick={() => (anotherRef.current = false)}>
          {busy ? (receipts.uploading ? "Uploading receipt…" : "Saving…") : seed ? "Save changes" : "Save"}
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
