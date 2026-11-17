import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api, type Category, type ReceiptExclusion } from "../api.ts";
import { useApi, usePersistentState, useSession, useToast, useScopedPath } from "../hooks.ts";
import { Modal } from "../lib.tsx";

type Policy = Category["receipt_policy"];
interface Sub {
  name: string;
  count: number;
  saved: boolean;
  /** own receipt rule; null = same as the category */
  receipt_policy: Policy | null;
  receipt_min: number | null;
}
interface TreeRow {
  category_id: number;
  count: number;
  subcategories: Sub[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const dollars = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const entries = (n: number) => `${n} ${n === 1 ? "entry" : "entries"}`;

/** "always", "never" or "$75+" */
const ruleText = (policy: Policy, min: number) =>
  policy === "always" ? "always" : policy === "never" ? "never" : `${dollars(min)}+`;

/**
 * Settings → Categories: categories with their subcategories indented underneath, and when each should ask for a
 * receipt (server/services/receipts.ts). Click a name to rename, archive, delete or change tax settings.
 */
export default function CategorySettings() {
  const { overview, reloadOverview, canWrite } = useSession();
  const tree = useApi<TreeRow[]>("categories/tree");
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = usePersistentState<number[]>("categories.expanded", []);
  // the category whose "Add a subcategory" box should take focus when it opens
  const [focusAdd, setFocusAdd] = useState<number | null>(null);
  const toast = useToast();
  const info = (id: number) => tree.data?.find((t) => t.category_id === id);
  const refresh = async () => {
    await Promise.all([tree.reload(), reloadOverview()]);
    window.dispatchEvent(new Event("todo:changed"));
  };
  const archived = overview.categories.filter((c) => c.archived);
  const open = overview.categories.find((c) => c.id === openId);
  const list = (kind: "expense" | "income") =>
    overview.categories.filter((c) => c.kind === kind && (showArchived || !c.archived));
  const toggle = (id: number) => setExpanded((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  const save = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ text: ok, kind: "ok" });
      await refresh();
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  const setCategoryRule = (c: Category, policy: Policy | "inherit", min: number | null) =>
    save(
      () => api(`categories/${c.id}`, { method: "PATCH", json: { receipt_policy: policy, receipt_min: min } }),
      `Receipts for ${c.name}: ${ruleText(policy as Policy, min ?? overview.receipt_min)}`,
    );
  const setSubRule = (c: Category, sub: Sub, policy: Policy | "inherit", min: number | null) =>
    save(
      () =>
        api("subcategories/receipt-rule", {
          method: "POST",
          json: { category: c.id, name: sub.name, receipt_policy: policy, receipt_min: min },
        }),
      policy === "inherit" ? `${sub.name} follows ${c.name} again` : `Receipt rule saved for ${sub.name}`,
    );

  return (
    <section className="card">
      <div className="section-head">
        <h2>Categories</h2>
        {canWrite && (
          <button className="btn" onClick={() => setCreating(true)}>
            + Add category
          </button>
        )}
      </div>

      {(["expense", "income"] as const).map((kind) => (
        <div key={kind} className="cat-list-group">
          <div className="cat-tree-head" aria-hidden="true">
            <span />
            <span>{kind === "expense" ? "Expenses" : "Income"}</span>
            <span>Entries</span>
            <span>{kind === "expense" ? "Ask for a receipt" : ""}</span>
          </div>
          <ul className="cat-tree">
            {list(kind).map((c) => {
              const t = info(c.id);
              const subs = t?.subcategories ?? [];
              const own = subs.filter((s) => s.receipt_policy != null).length;
              const isOpen = expanded.includes(c.id);
              const canOpen = subs.length > 0 || canWrite;
              const catMin = c.receipt_min ?? overview.receipt_min;
              return (
                <li key={c.id} className={c.archived ? "archived" : ""}>
                  <div className="cat-tree-row">
                    {canOpen ? (
                      <button
                        className="tree-toggle"
                        onClick={() => toggle(c.id)}
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Hide" : "Show"} ${c.name} subcategories`}
                      >
                        {isOpen ? "▾" : "▸"}
                      </button>
                    ) : (
                      <span />
                    )}
                    <span className="cat-tree-name">
                      <button className="link-plain" onClick={() => setOpenId(c.id)} disabled={!canWrite}>
                        {c.name}
                      </button>
                      {c.archived && <span className="badge muted">archived</span>}
                      {subs.length > 0 && !isOpen && (
                        <button className="link small muted-link" onClick={() => toggle(c.id)}>
                          {subs.length} {subs.length === 1 ? "subcategory" : "subcategories"}
                          {own > 0 && kind === "expense" && ` · ${own} with own rule`}
                        </button>
                      )}
                      {subs.length === 0 && canWrite && !isOpen && (
                        <button
                          className="link small muted-link"
                          onClick={() => {
                            setFocusAdd(c.id);
                            toggle(c.id);
                          }}
                        >
                          + subcategory
                        </button>
                      )}
                    </span>
                    <span className="cat-row-count">{t ? entries(t.count) : ""}</span>
                    {kind === "expense" ? (
                      <ReceiptControl
                        label={`Receipts for ${c.name}`}
                        policy={c.receipt_policy}
                        min={c.receipt_min}
                        fallbackMin={overview.receipt_min}
                        canWrite={canWrite}
                        onChange={(p, m) => setCategoryRule(c, p, m)}
                      />
                    ) : (
                      <span />
                    )}
                  </div>
                  {isOpen && canOpen && (
                    <ul className="cat-subtree">
                      {subs.map((sub) => (
                        <li key={sub.name} className="cat-tree-row sub">
                          <span />
                          <span className="cat-tree-name">{sub.name}</span>
                          <span className="cat-row-count">{sub.count ? entries(sub.count) : "not used yet"}</span>
                          {kind === "expense" ? (
                            <ReceiptControl
                              label={`Receipts for ${c.name} › ${sub.name}`}
                              policy={sub.receipt_policy}
                              min={sub.receipt_min}
                              fallbackMin={catMin}
                              inherited={ruleText(c.receipt_policy, catMin)}
                              canWrite={canWrite}
                              onChange={(p, m) => setSubRule(c, sub, p, m)}
                            />
                          ) : (
                            <span />
                          )}
                        </li>
                      ))}
                      {canWrite && (
                        <li className="cat-tree-row sub add">
                          <span />
                          <AddSubcategory category={c} autoFocus={focusAdd === c.id} onAdded={refresh} />
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {archived.length > 0 && (
        <button className="link small" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Hide archived" : `Show ${archived.length} archived`}
        </button>
      )}

      <VendorList canWrite={canWrite} />

      {open && (
        <CategoryPanel
          key={open.id}
          category={open}
          info={info(open.id)}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      )}
      {creating && (
        <NewCategory
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await refresh();
            // open it with the subcategory box ready
            setFocusAdd(id);
            setExpanded((xs) => (xs.includes(id) ? xs : [...xs, id]));
          }}
        />
      )}
    </section>
  );
}

/**
 * When to ask for a receipt. One select; an amount box appears only for "Other amount…". `inherited` adds a
 * "Same as category" choice, shown when `policy` is null.
 */
function ReceiptControl({
  label,
  policy,
  min,
  fallbackMin,
  inherited,
  canWrite,
  onChange,
}: {
  label: string;
  policy: Policy | null;
  min: number | null;
  /** what "threshold" with no amount of its own means here */
  fallbackMin: number;
  inherited?: string;
  canWrite: boolean;
  onChange: (policy: Policy | "inherit", min: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  const [amount, setAmount] = useState(min == null ? "" : String(min));
  if (!canWrite)
    return (
      <span className={`receipt-text ${policy == null ? "muted" : ""}`}>
        {policy == null ? `Same as category (${inherited})` : ruleText(policy, min ?? fallbackMin)}
      </span>
    );
  const custom = editing || (policy === "threshold" && min != null);
  const value = custom ? "custom" : (policy ?? "inherit");
  const pick = (v: string) => {
    if (v === "custom") {
      cancelled.current = false;
      setAmount(min == null ? "" : String(min));
      setEditing(true);
      return;
    }
    setEditing(false);
    void onChange(v as Policy | "inherit", null);
  };
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const n = Number(amount);
    setEditing(false);
    if (amount.trim() === "" || !Number.isFinite(n) || n <= 0) return setAmount(min == null ? "" : String(min));
    if (n !== min || policy !== "threshold") void onChange("threshold", n);
  };
  return (
    <span className="receipt-control">
      <select
        aria-label={label}
        className={policy == null && !editing ? "inherited" : ""}
        value={value}
        onChange={(e) => pick(e.target.value)}
      >
        {inherited != null && <option value="inherit">Same as category ({inherited})</option>}
        <option value="threshold">{dollars(fallbackMin)} or more</option>
        <option value="custom">{custom ? "At least" : "Other amount…"}</option>
        <option value="always">Always</option>
        <option value="never">Never</option>
      </select>
      {custom && (
        <span className="receipt-amount">
          $
          <input
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            autoFocus={editing}
            value={amount}
            placeholder={String(fallbackMin)}
            aria-label={`${label}: at least this many dollars`}
            onChange={(e) => setAmount(e.target.value)}
            onFocus={() => {
              cancelled.current = false;
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                cancelled.current = true;
                setAmount(min == null ? "" : String(min));
                setEditing(false);
              }
            }}
          />
          or more
        </span>
      )}
    </span>
  );
}

/** The last row of an open category: type a name to add a subcategory under it. */
function AddSubcategory({
  category: c,
  autoFocus,
  onAdded,
}: {
  category: Category;
  autoFocus: boolean;
  onAdded: () => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try {
      await api("subcategories", { method: "POST", json: { category: c.id, name: n } });
      toast({ text: `Added ${n} under ${c.name}`, kind: "ok" });
      setName("");
      await onAdded();
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  return (
    <form className="inline-form add-sub" onSubmit={(e) => void add(e)}>
      <input
        className="grow"
        autoFocus={autoFocus}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={`Add a subcategory to ${c.name}`}
        aria-label={`New subcategory in ${c.name}`}
      />
      <button className="btn small" disabled={!name.trim()}>
        Add
      </button>
    </form>
  );
}

/** Vendors that never need a receipt, in any category (e.g. Stripe, Airbnb). */
function VendorList({ canWrite }: { canWrite: boolean }) {
  const list = useApi<ReceiptExclusion[]>("receipt-exclusions");
  const sugg = useApi<{ vendors: { vendor: string }[] }>("suggestions");
  const toast = useToast();
  const [name, setName] = useState("");
  const items = list.data ?? [];
  const has = (n: string) => items.some((x) => x.name.toLowerCase() === n.trim().toLowerCase());
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ text: ok, kind: "ok" });
      await list.reload();
      window.dispatchEvent(new Event("todo:changed"));
      return true;
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
      return false;
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (
      n &&
      !has(n) &&
      (await run(
        () => api("receipt-exclusions", { method: "POST", json: { name: n } }),
        `Won't ask for receipts from ${n}`,
      ))
    )
      setName("");
  };
  return (
    <div className="cat-list-group">
      <h3 className="group-title">Vendors that never need a receipt</h3>
      <p className="muted small">For payees like Stripe or Airbnb, in whatever category they're entered under.</p>
      {items.length > 0 && (
        <ul className="sub-list">
          {items.map((x) => (
            <li key={x.id} className="sub-row">
              <span>
                {x.name}{" "}
                <span className="muted small">{x.matches ? plural(x.matches, "expense") : "no matches yet"}</span>
              </span>
              {canWrite && (
                <button
                  className="link small danger"
                  onClick={() =>
                    void run(
                      () => api(`receipt-exclusions/${x.id}`, { method: "DELETE" }),
                      `Receipts asked from ${x.name} again`,
                    )
                  }
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form onSubmit={(e) => void add(e)} className="inline-form">
          <input
            className="grow"
            list="receipt-vendor-suggestions"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Vendor, e.g. Stripe"
            aria-label="Vendor that never needs a receipt"
          />
          <datalist id="receipt-vendor-suggestions">
            {(sugg.data?.vendors ?? [])
              .filter((v) => !has(v.vendor))
              .map((v) => (
                <option key={v.vendor} value={v.vendor} />
              ))}
          </datalist>
          <button className="btn" disabled={!name.trim() || has(name)}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function NewCategory({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [allocation, setAllocation] = useState<"direct" | "indirect">("direct");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const created = await api<Category>("categories", {
        method: "POST",
        json: {
          name,
          kind,
          default_allocation: kind === "income" ? null : allocation,
          schedule_e_line: kind === "income" ? "3" : "19",
        },
      });
      toast({ text: `Added ${name}`, kind: "ok" });
      await onCreated(created.id);
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  return (
    <Modal title="Add category" onClose={onClose}>
      <form onSubmit={save}>
        <label>
          Name
          <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="segmented" role="radiogroup" aria-label="Type">
          {(["expense", "income"] as const).map((k) => (
            <button type="button" key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {k === "expense" ? "Expense" : "Income"}
            </button>
          ))}
        </div>
        {kind === "expense" && <TaxChoice value={allocation} onChange={setAllocation} />}
        <p className="muted small">
          You can set the Schedule E line later; it defaults to "Other". Add subcategories in the list once it's
          created.
        </p>
        <div className="form-actions">
          <span className="spacer" />
          <button className="btn primary">Add</button>
        </div>
      </form>
    </Modal>
  );
}

function TaxChoice({
  value,
  onChange,
}: {
  value: "direct" | "indirect" | null;
  onChange: (v: "direct" | "indirect") => void;
}) {
  return (
    <fieldset className="field">
      <legend>Who is it for?</legend>
      <label className="check">
        <input type="radio" checked={value === "direct"} onChange={() => onChange("direct")} />
        Only the rental (direct, deducted in full)
      </label>
      <label className="check">
        <input type="radio" checked={value === "indirect"} onChange={() => onChange("indirect")} />
        The whole property (indirect, split by rental days)
      </label>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

function CategoryPanel({
  category: c,
  info,
  onClose,
  onChanged,
}: {
  category: Category;
  info: TreeRow | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const scoped = useScopedPath();
  const { overview, user } = useSession();
  const toast = useToast();
  const [name, setName] = useState(c.name);
  const [newSub, setNewSub] = useState("");
  const [showTax, setShowTax] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const count = info?.count ?? 0;
  const subs = info?.subcategories ?? [];
  const lines = overview.schedule_e_lines;
  const taxSummary =
    "Tax settings: " +
    [
      c.kind === "expense" &&
        (c.default_allocation === "direct"
          ? "direct"
          : c.default_allocation === "indirect"
            ? "indirect"
            : "ask each time"),
      c.schedule_e_line && `Schedule E line ${c.schedule_e_line} (${lines[c.schedule_e_line]})`,
    ]
      .filter(Boolean)
      .join(" · ");

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ text: ok, kind: "ok" });
      await onChanged();
      return true;
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
      return false;
    }
  };
  const patch = (json: Partial<Category>, ok: string) =>
    run(() => api(`categories/${c.id}`, { method: "PATCH", json }), ok);

  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== c.name) void patch({ name: name.trim() }, `Renamed to ${name.trim()}`);
  };
  const addSub = async (e: FormEvent) => {
    e.preventDefault();
    const n = newSub.trim();
    if (!n) return;
    if (await run(() => api("subcategories", { method: "POST", json: { category: c.id, name: n } }), `Added ${n}`))
      setNewSub("");
  };

  return (
    <Modal title={c.name} onClose={onClose}>
      <div className="panel-label">Name</div>
      <form onSubmit={rename} className="inline-form">
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
        <button className="btn" disabled={!name.trim() || name.trim() === c.name}>
          Rename
        </button>
      </form>
      <p className="muted small">
        <Link to={scoped(`/transactions?year=all&category=${c.id}`)}>{plural(count, "transaction")}</Link>
        {count > 0 && " · renaming keeps them all in this category"}
      </p>

      <div className="panel-label">Subcategories</div>
      {subs.length === 0 && <p className="muted small">None yet.</p>}
      <ul className="sub-list">
        {subs.map((s) => (
          <SubRow key={s.name} category={c} sub={s} siblings={subs.filter((x) => x !== s)} run={run} />
        ))}
      </ul>
      <form onSubmit={(e) => void addSub(e)} className="inline-form">
        <input
          className="grow"
          value={newSub}
          onChange={(e) => setNewSub(e.target.value)}
          placeholder="New subcategory, e.g. Water"
          aria-label="New subcategory"
        />
        <button className="btn" disabled={!newSub.trim()}>
          Add
        </button>
      </form>

      <hr className="sep" />
      {!showTax ? (
        <button className="link small" onClick={() => setShowTax(true)}>
          {taxSummary}
        </button>
      ) : (
        <div>
          <div className="panel-label">Tax settings</div>
          {c.kind === "expense" && (
            <TaxChoice
              value={c.default_allocation}
              onChange={(v) => void patch({ default_allocation: v }, "Tax treatment updated")}
            />
          )}
          <label>
            Schedule E line
            <select
              value={c.schedule_e_line ?? ""}
              onChange={(e) => void patch({ schedule_e_line: e.target.value || null }, "Schedule E line updated")}
            >
              <option value="">—</option>
              {Object.entries(lines).map(([k, v]) => (
                <option key={k} value={k}>
                  {k} · {v}
                </option>
              ))}
            </select>
          </label>
          {c.kind === "expense" && (
            <p className="muted small">
              The tax choice is the default for new entries; existing entries keep whatever they have.
            </p>
          )}
        </div>
      )}

      <hr className="sep" />
      {!deleting ? (
        <div className="form-actions">
          <button
            className="btn"
            onClick={() => void patch({ archived: !c.archived }, c.archived ? "Restored" : `Archived ${c.name}`)}
          >
            {c.archived ? "Unarchive" : "Archive"}
          </button>
          <span className="muted small grow">
            {c.archived ? "Hidden when adding entries." : "Archive to hide it when adding entries; history stays."}
          </span>
          {user.role === "admin" && (
            <button className="btn danger-outline" onClick={() => setDeleting(true)}>
              Delete…
            </button>
          )}
        </div>
      ) : (
        <DeleteCategory category={c} count={count} onCancel={() => setDeleting(false)} run={run} onDone={onClose} />
      )}
    </Modal>
  );
}

type Run = (fn: () => Promise<unknown>, ok: string) => Promise<boolean>;

function SubRow({ category, sub, siblings, run }: { category: Category; sub: Sub; siblings: Sub[]; run: Run }) {
  const [mode, setMode] = useState<"view" | "rename" | "remove">("view");
  const [name, setName] = useState(sub.name);
  const [moveTo, setMoveTo] = useState("");
  const merging = siblings.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  const uses = plural(sub.count, "transaction");

  if (mode === "rename")
    return (
      <li className="sub-row editing">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                api("subcategories/rename", {
                  method: "POST",
                  json: { category: category.id, from: sub.name, to: name.trim() },
                }),
              merging ? `Merged into ${merging.name}` : `Renamed to ${name.trim()}`,
            );
          }}
        >
          <input className="grow" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn small primary" disabled={!name.trim() || name.trim() === sub.name}>
            {merging ? "Merge" : "Save"}
          </button>
          <button type="button" className="btn small" onClick={() => setMode("view")}>
            Cancel
          </button>
        </form>
        <small className="hint">
          {merging ? `Combines with ${merging.name}. ` : ""}
          {sub.count ? `Updates ${uses}.` : ""}
        </small>
      </li>
    );

  if (mode === "remove")
    return (
      <li className="sub-row editing">
        <span>
          Remove <strong>{sub.name}</strong>
          {sub.count > 0 && (
            <>
              {" "}
              — its {uses}:{" "}
              <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move to">
                <option value="">keep with no subcategory</option>
                {siblings.map((s) => (
                  <option key={s.name} value={s.name}>
                    move to {s.name}
                  </option>
                ))}
              </select>
            </>
          )}
        </span>
        <span className="sub-actions">
          <button
            className="btn small danger-outline"
            onClick={() =>
              void run(
                () =>
                  api("subcategories/remove", {
                    method: "POST",
                    json: { category: category.id, name: sub.name, move_to: moveTo },
                  }),
                `Removed ${sub.name}`,
              )
            }
          >
            Remove
          </button>
          <button className="btn small" onClick={() => setMode("view")}>
            Cancel
          </button>
        </span>
      </li>
    );

  return (
    <li className="sub-row">
      <span>
        {sub.name} <span className="muted small">{sub.count ? uses : "not used yet"}</span>
      </span>
      <span className="sub-actions">
        <button className="link small" onClick={() => setMode("rename")}>
          Rename
        </button>
        <button className="link small danger" onClick={() => setMode("remove")}>
          Remove
        </button>
      </span>
    </li>
  );
}

function DeleteCategory({
  category: c,
  count,
  onCancel,
  run,
  onDone,
}: {
  category: Category;
  count: number;
  onCancel: () => void;
  run: Run;
  onDone: () => void;
}) {
  const { overview } = useSession();
  const [moveTo, setMoveTo] = useState("");
  const targets = overview.categories.filter((x) => x.kind === c.kind && x.id !== c.id && !x.archived);
  return (
    <div className="danger-box">
      {count ? (
        <label>
          Delete {c.name} and move its {plural(count, "transaction")} (and subcategories) to
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <option value="">Pick a category…</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p>Delete {c.name}? Nothing uses it.</p>
      )}
      <div className="form-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <span className="spacer" />
        <button
          className="btn danger-outline"
          disabled={count > 0 && !moveTo}
          onClick={() =>
            void run(
              () => api(`categories/${c.id}`, { method: "DELETE", json: count ? { move_to: Number(moveTo) } : {} }),
              `Deleted ${c.name}`,
            ).then((ok) => ok && onDone())
          }
        >
          {count ? "Move and delete" : "Delete"}
        </button>
      </div>
    </div>
  );
}
