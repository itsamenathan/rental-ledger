import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api, type Category, type ReceiptExclusion } from "../api.ts";
import { useApi, useSession, useToast } from "../hooks.ts";
import { Modal } from "../lib.tsx";

interface Sub {
  name: string;
  count: number;
  saved: boolean;
}
interface TreeRow {
  category_id: number;
  count: number;
  subcategories: Sub[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const dollars = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/** Short note for the list when a category's receipt rule isn't the default. */
function receiptBadge(c: Category) {
  if (c.kind !== "expense") return null;
  if (c.receipt_policy === "never") return "no receipts";
  if (c.receipt_policy === "always") return "receipt always";
  if (c.receipt_min != null) return `receipt ${dollars(c.receipt_min)}+`;
  return null;
}

/** Names (vendor or subcategory) that never need a receipt, and a way to toggle one. */
interface NeverAsk {
  has: (name: string) => boolean;
  toggle: (name: string) => Promise<boolean>;
}

/** Settings → Categories: a plain list; click a category to manage it and its subcategories. */
export default function CategorySettings() {
  const { overview, reloadOverview, canWrite } = useSession();
  const tree = useApi<TreeRow[]>("categories/tree");
  const exclusions = useApi<ReceiptExclusion[]>("receipt-exclusions");
  const toast = useToast();
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const info = (id: number) => tree.data?.find((t) => t.category_id === id);
  const refresh = async () => {
    await Promise.all([tree.reload(), exclusions.reload(), reloadOverview()]);
  };
  const excluded = (name: string) => exclusions.data?.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  const neverAsk: NeverAsk = {
    has: (name) => !!excluded(name),
    toggle: async (name) => {
      const ex = excluded(name);
      try {
        if (ex) await api(`receipt-exclusions/${ex.id}`, { method: "DELETE" });
        else await api("receipt-exclusions", { method: "POST", json: { name } });
        toast({ text: ex ? `Receipts asked for ${name} again` : `Won't ask for receipts for ${name}`, kind: "ok" });
        await exclusions.reload();
        window.dispatchEvent(new Event("todo:changed"));
        return true;
      } catch (err) {
        toast({ text: (err as Error).message, kind: "error" });
        return false;
      }
    },
  };
  const archived = overview.categories.filter((c) => c.archived);
  const open = overview.categories.find((c) => c.id === openId);

  const list = (kind: "expense" | "income") =>
    overview.categories.filter((c) => c.kind === kind && (showArchived || !c.archived));

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
          <h3 className="group-title">{kind === "expense" ? "Expenses" : "Income"}</h3>
          <ul className="cat-list">
            {list(kind).map((c) => {
              const t = info(c.id);
              const subs = t?.subcategories ?? [];
              return (
                <li key={c.id}>
                  <button
                    className={`cat-row ${c.archived ? "archived" : ""}`}
                    onClick={() => setOpenId(c.id)}
                    disabled={!canWrite}
                  >
                    <span className="cat-row-name">
                      {c.name}
                      {c.archived && <span className="badge muted">archived</span>}
                      {receiptBadge(c) && <span className="badge muted">{receiptBadge(c)}</span>}
                    </span>
                    <span className="cat-row-subs">{subs.length ? subs.map((s) => s.name).join(", ") : "—"}</span>
                    <span className="cat-row-count">
                      {t ? `${t.count} ${t.count === 1 ? "entry" : "entries"}` : ""}
                    </span>
                    {canWrite && <span className="cat-row-go">›</span>}
                  </button>
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

      <NeverAskList
        items={exclusions.data ?? []}
        suggestions={[...new Set((tree.data ?? []).flatMap((t) => t.subcategories.map((s) => s.name)))]}
        canWrite={canWrite}
        neverAsk={neverAsk}
      />

      {open && (
        <CategoryPanel
          key={open.id}
          category={open}
          info={info(open.id)}
          neverAsk={neverAsk}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      )}
      {creating && (
        <NewCategory
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function NewCategory({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [allocation, setAllocation] = useState<"direct" | "indirect">("direct");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("categories", {
        method: "POST",
        json: {
          name,
          kind,
          default_allocation: kind === "income" ? null : allocation,
          schedule_e_line: kind === "income" ? "3" : "19",
        },
      });
      toast({ text: `Added ${name}`, kind: "ok" });
      await onCreated();
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
        <p className="muted small">You can set the Schedule E line later; it defaults to "Other".</p>
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
  neverAsk,
  onClose,
  onChanged,
}: {
  category: Category;
  info: TreeRow | undefined;
  neverAsk: NeverAsk;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
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
        <Link to={`/transactions?year=all&category=${c.id}`}>{plural(count, "transaction")}</Link>
        {count > 0 && " · renaming keeps them all in this category"}
      </p>

      <div className="panel-label">Subcategories</div>
      {subs.length === 0 && <p className="muted small">None yet.</p>}
      <ul className="sub-list">
        {subs.map((s) => (
          <SubRow
            key={s.name}
            category={c}
            sub={s}
            siblings={subs.filter((x) => x !== s)}
            run={run}
            neverAsk={c.kind === "expense" ? neverAsk : undefined}
          />
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

      {c.kind === "expense" && (
        <>
          <hr className="sep" />
          <ReceiptRule category={c} patch={patch} />
        </>
      )}

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

function SubRow({
  category,
  sub,
  siblings,
  run,
  neverAsk,
}: {
  category: Category;
  sub: Sub;
  siblings: Sub[];
  run: Run;
  neverAsk?: NeverAsk;
}) {
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
        {neverAsk?.has(sub.name) && <span className="badge muted">no receipts</span>}
      </span>
      <span className="sub-actions">
        {neverAsk && (
          <button
            className="link small"
            onClick={() => void neverAsk.toggle(sub.name)}
            title={
              neverAsk.has(sub.name)
                ? "Ask for receipts for this again"
                : "Never ask for receipts for this name, in any category"
            }
          >
            {neverAsk.has(sub.name) ? "Ask for receipts" : "No receipts"}
          </button>
        )}
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

// ---------------------------------------------------------------------------

/** When expenses in this category should have a receipt (To do, Files and the tax report all follow it). */
function ReceiptRule({
  category: c,
  patch,
}: {
  category: Category;
  patch: (json: Partial<Category>, ok: string) => Promise<boolean>;
}) {
  const { overview } = useSession();
  const [min, setMin] = useState(c.receipt_min == null ? "" : String(c.receipt_min));
  const effective = c.receipt_min ?? overview.receipt_min;
  const minValue = min.trim() === "" ? null : Number(min);
  const minValid = minValue == null || (Number.isFinite(minValue) && minValue > 0);
  return (
    <div>
      <div className="panel-label">Receipts</div>
      <label>
        Ask for a receipt
        <select
          value={c.receipt_policy}
          onChange={(e) =>
            void patch({ receipt_policy: e.target.value as Category["receipt_policy"] }, "Receipt rule updated")
          }
        >
          <option value="threshold">When it's {dollars(effective)} or more</option>
          <option value="always">For every expense</option>
          <option value="never">Never</option>
        </select>
      </label>
      {c.receipt_policy === "threshold" && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (minValid) void patch({ receipt_min: minValue }, "Receipt amount updated");
          }}
        >
          <input
            className="grow"
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            placeholder={`${overview.receipt_min} (default)`}
            aria-label="Receipt amount in dollars"
          />
          <button className="btn" disabled={!minValid || minValue === c.receipt_min}>
            Save
          </button>
        </form>
      )}
      <p className="muted small">
        Expenses that need one show up on To do, under Files → Needs a receipt, and in the tax report check. To skip a
        payee like Airbnb or the sewer bill in every category, use "No receipts" on its subcategory or the never-ask
        list on the Categories page.
      </p>
    </div>
  );
}

/** Settings → Categories footer: vendor/subcategory names that never need a receipt. */
function NeverAskList({
  items,
  suggestions,
  canWrite,
  neverAsk,
}: {
  items: ReceiptExclusion[];
  suggestions: string[];
  canWrite: boolean;
  neverAsk: NeverAsk;
}) {
  const [name, setName] = useState("");
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n && !neverAsk.has(n) && (await neverAsk.toggle(n))) setName("");
  };
  return (
    <div className="cat-list-group">
      <h3 className="group-title">Never ask for a receipt</h3>
      <p className="muted small">
        Payees that never need a receipt, in any category (e.g. Airbnb, Stripe, the sewer utility). Each name matches an
        entry's vendor or its subcategory, ignoring case.
      </p>
      {items.length === 0 && <p className="muted small">None yet.</p>}
      <ul className="sub-list">
        {items.map((x) => (
          <li key={x.id} className="sub-row">
            <span>
              {x.name}{" "}
              <span className="muted small">{x.matches ? plural(x.matches, "expense") : "no matches yet"}</span>
            </span>
            {canWrite && (
              <span className="sub-actions">
                <button className="link small danger" onClick={() => void neverAsk.toggle(x.name)}>
                  Remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {canWrite && (
        <form onSubmit={(e) => void add(e)} className="inline-form">
          <input
            className="grow"
            list="never-ask-suggestions"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Vendor or subcategory, e.g. Sewer"
            aria-label="Name that never needs a receipt"
          />
          <datalist id="never-ask-suggestions">
            {suggestions
              .filter((s) => !neverAsk.has(s))
              .map((s) => (
                <option key={s} value={s} />
              ))}
          </datalist>
          <button className="btn" disabled={!name.trim() || neverAsk.has(name)}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}
