import { useMemo, useState } from "react";
import { api } from "../api.ts";
import { money } from "../format.ts";
import { useApi, usePersistentState, useSession, useToast } from "../hooks.ts";

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function parseDate(s: string): string | null {
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  return null;
}
const parseAmount = (s: string) => {
  const t = s.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  return t === "" ? null : Number(t);
};

interface Mapping {
  date: number;
  description: number;
  amount: number;
  debit: number;
  credit: number;
  flip: boolean;
}

interface Row {
  date: string | null;
  amount: number | null;
  description: string;
  category_id: number | null;
  vendor: string;
  include: boolean;
  status?: string;
  dupes?: number[];
  error?: string;
}

interface Suggestions {
  vendors: { vendor: string; category: string; allocation: string | null }[];
}

export default function ImportCsv() {
  const { overview, canWrite } = useSession();
  const sugg = useApi<Suggestions>("suggestions");
  const toast = useToast();
  const [grid, setGrid] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = usePersistentState<Mapping>("csv-mapping", {
    date: 0,
    description: 1,
    amount: 2,
    debit: -1,
    credit: -1,
    flip: false,
  });
  const [account, setAccount] = usePersistentState("csv-account", "");
  const [flagReview, setFlagReview] = useState(true);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [propertyId, setPropertyId] = useState(overview.properties.find((p) => !p.archived)?.id ?? 0);

  const header = grid && hasHeader ? grid[0]! : (grid?.[0]?.map((_, i) => `Column ${i + 1}`) ?? []);
  const body = useMemo(() => (grid ? (hasHeader ? grid.slice(1) : grid) : []), [grid, hasHeader]);
  const incomeCats = overview.categories.filter((c) => c.kind === "income" && !c.archived);
  const expenseCats = overview.categories.filter((c) => c.kind === "expense" && !c.archived);

  const guess = (desc: string, amount: number) => {
    const d = desc.toLowerCase();
    const hit = sugg.data?.vendors.find((v) => v.vendor.length > 2 && d.includes(v.vendor.toLowerCase()));
    const cat =
      hit && overview.categories.find((c) => c.name === hit.category && c.kind === (amount > 0 ? "income" : "expense"));
    if (cat) return { category_id: cat.id, vendor: hit!.vendor };
    if (amount > 0) {
      const vendor = /airbnb/i.test(desc) ? "Airbnb" : /vrbo|homeaway/i.test(desc) ? "VRBO" : "";
      return { category_id: incomeCats[0]?.id ?? null, vendor };
    }
    return { category_id: null, vendor: "" };
  };

  const buildRows = () => {
    const out: Row[] = body.map((r) => {
      let amount: number | null;
      if (mapping.amount >= 0) amount = parseAmount(r[mapping.amount] ?? "");
      else {
        const debit = parseAmount(r[mapping.debit] ?? "") ?? 0;
        const credit = parseAmount(r[mapping.credit] ?? "") ?? 0;
        amount = credit - Math.abs(debit);
      }
      if (amount != null && mapping.flip) amount = -amount;
      const description = (r[mapping.description] ?? "").trim();
      const g = amount != null ? guess(description, amount) : { category_id: null, vendor: "" };
      return {
        date: parseDate(r[mapping.date] ?? ""),
        amount,
        description,
        ...g,
        include: amount != null && amount !== 0,
      };
    });
    setRows(out);
    setChecked(false);
  };

  const payload = () =>
    rows!
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.include)
      .map(({ r }) => ({
        property_id: propertyId,
        date: r.date,
        amount: r.amount,
        category_id: r.category_id ?? undefined,
        vendor: r.vendor,
        reference: r.description,
        account,
        needs_review: flagReview,
        review_note: flagReview ? `Imported from ${fileName}` : "",
        refund: true, // bank data is authoritative about direction
      }));

  const send = async (dryRun: boolean) => {
    if (!rows) return;
    const included = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.include);
    if (included.some(({ r }) => !r.category_id))
      return toast({ text: "Pick a category for every included row (or exclude it)", kind: "error" });
    setBusy(true);
    try {
      const res = await api<{
        created: number;
        duplicates: number;
        errors: number;
        would_create: number;
        results: { index: number; status: string; duplicate_of?: number[]; error?: string }[];
      }>("transactions/bulk", {
        method: "POST",
        json: { transactions: payload(), dry_run: dryRun, skip_duplicates: true },
      });
      const next = [...rows];
      for (const r of res.results) {
        const target = included[r.index]!.i;
        next[target] = { ...next[target]!, status: r.status, dupes: r.duplicate_of, error: r.error };
        if (r.status === "duplicate" && dryRun) next[target]!.include = false;
      }
      setRows(next);
      if (dryRun) {
        setChecked(true);
        toast({
          text: `${res.would_create} new, ${res.duplicates} duplicates, ${res.errors} errors`,
          kind: res.errors ? "error" : "ok",
        });
      } else {
        toast({ text: `Imported ${res.created} transactions`, kind: "ok" });
        setGrid(null);
        setRows(null);
      }
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const update = (i: number, patch: Partial<Row>) => {
    setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setChecked(false);
  };

  if (!canWrite) return <div className="page">Read-only accounts cannot import.</div>;

  const colSelect = (key: keyof Omit<Mapping, "flip">, label: string, optional = false) => (
    <label>
      {label}
      <select value={mapping[key]} onChange={(e) => setMapping({ ...mapping, [key]: Number(e.target.value) })}>
        {optional && <option value={-1}>—</option>}
        {header.map((h, i) => (
          <option key={i} value={i}>
            {h}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="page">
      <header className="page-head">
        <h1>Import CSV</h1>
      </header>
      <section className="card">
        <p className="muted">
          Upload a bank or card export. Rows are matched against existing transactions so re-importing an overlapping
          date range won't create duplicates. AI agents can do the same through the API (
          <code>bulk_add_transactions</code>).
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFileName(f.name);
            setGrid(parseCsv(await f.text()));
            setRows(null);
          }}
        />
      </section>

      {grid && (
        <section className="card">
          <h2>Columns</h2>
          <label className="check">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> First row is
            a header
          </label>
          <div className="row-3">
            {colSelect("date", "Date")}
            {colSelect("description", "Description")}
            {colSelect("amount", "Amount (signed)", true)}
            {mapping.amount < 0 && colSelect("debit", "Debit / withdrawal")}
            {mapping.amount < 0 && colSelect("credit", "Credit / deposit")}
          </div>
          <div className="row-3">
            <label className="check">
              <input
                type="checkbox"
                checked={mapping.flip}
                onChange={(e) => setMapping({ ...mapping, flip: e.target.checked })}
              />{" "}
              Flip signs (card exports often show charges as positive)
            </label>
            <label>
              Account name
              <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. Checking" />
            </label>
            {overview.properties.length > 1 && (
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
          </div>
          <label className="check">
            <input type="checkbox" checked={flagReview} onChange={(e) => setFlagReview(e.target.checked)} /> Flag
            imported rows for review
          </label>
          <p className="muted small">
            Preview:{" "}
            {body
              .slice(0, 2)
              .map((r) => r.join(" | "))
              .join("  ⏎  ")}
          </p>
          <button className="btn primary" onClick={buildRows}>
            Preview {body.length} rows
          </button>
        </section>
      )}

      {rows && (
        <section className="card table-card">
          <table className="data-table import-table">
            <thead>
              <tr>
                <th>Use</th>
                <th>Date</th>
                <th>Description</th>
                <th>Category</th>
                <th>Vendor</th>
                <th className="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={r.include ? "" : "excluded"}>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.include}
                      onChange={(e) => update(i, { include: e.target.checked })}
                      aria-label="Include row"
                    />
                  </td>
                  <td>{r.date ?? <span className="neg">bad date</span>}</td>
                  <td className="desc">{r.description}</td>
                  <td>
                    <select
                      value={r.category_id ?? ""}
                      onChange={(e) => update(i, { category_id: Number(e.target.value) || null })}
                      aria-label="Category"
                    >
                      <option value="">Choose…</option>
                      {((r.amount ?? 0) > 0 ? incomeCats : expenseCats).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                      <optgroup label="Other type">
                        {((r.amount ?? 0) > 0 ? expenseCats : incomeCats).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </td>
                  <td>
                    <input
                      className="cell-input wide"
                      value={r.vendor}
                      onChange={(e) => update(i, { vendor: e.target.value })}
                      aria-label="Vendor"
                    />
                  </td>
                  <td className="num">{r.amount == null ? "—" : money(r.amount)}</td>
                  <td>
                    {r.status === "duplicate" && (
                      <span className="badge warn" title={`Matches #${r.dupes?.join(", #")}`}>
                        Duplicate
                      </span>
                    )}
                    {r.status === "would_create" && (
                      <span className="badge ok">New{r.dupes?.length ? " (similar exists)" : ""}</span>
                    )}
                    {r.status === "error" && (
                      <span className="badge err" title={r.error}>
                        Error
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-actions">
            <span className="muted">{rows.filter((r) => r.include).length} rows selected</span>
            <span className="spacer" />
            <button className="btn" disabled={busy} onClick={() => void send(true)}>
              Check for duplicates
            </button>
            <button
              className="btn primary"
              disabled={busy || !checked}
              onClick={() => void send(false)}
              title={checked ? "" : "Run the duplicate check first"}
            >
              Import
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
