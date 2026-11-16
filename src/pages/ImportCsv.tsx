import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import TxEditModal from "../components/TxEditModal.tsx";
import { fmtDate, money } from "../format.ts";
import { usePersistentState, useSession, useToast } from "../hooks.ts";

// ---------- types (mirror server/services/csv-import.ts) ----------

const FIELDS = {
  date: { label: "Date", hint: "When it was paid or received" },
  amount: { label: "Amount (+/−)", hint: "One signed amount column" },
  money_out: { label: "Money out", hint: "Debits / withdrawals / charges" },
  money_in: { label: "Money in", hint: "Credits / deposits" },
  direction: { label: "Debit / credit type", hint: "A column saying which way the money went" },
  reference: { label: "Bank description", hint: "Used to spot duplicates and guess the vendor" },
  vendor: { label: "Payee / vendor", hint: "" },
  category: { label: "Category", hint: "Matched to your categories by name" },
  subcategory: { label: "Subcategory", hint: "" },
  description: { label: "Notes / memo", hint: "" },
  external_id: { label: "Transaction ID", hint: "A unique id per row: makes re-imports exact" },
  account: { label: "Account", hint: "" },
  property: { label: "Property", hint: "Matched by name" },
} as const;
type Field = keyof typeof FIELDS;
const FIELD_GROUPS: { label: string; fields: Field[] }[] = [
  { label: "Required", fields: ["date", "amount", "money_out", "money_in", "direction"] },
  { label: "Details", fields: ["reference", "vendor", "category", "subcategory", "description"] },
  { label: "Other", fields: ["external_id", "account", "property"] },
];

interface Mapping {
  delimiter: "," | ";" | "\t" | "|";
  header_row: number;
  has_header: boolean;
  columns: Partial<Record<Field, string>>;
  date_format: "YMD" | "MDY" | "DMY";
  number_format: "us" | "eu";
  amount_mode: "signed" | "split" | "direction";
  negate: boolean;
  outflow_values: string[];
  account: string;
}

interface Inspection {
  delimiter: Mapping["delimiter"];
  header_row: number;
  has_header: boolean;
  row_count: number;
  preamble: string[][];
  columns: { key: string; label: string; samples: string[]; values: string[] | null }[];
  headers: string[];
  profile: { id: number; name: string } | null;
  mapping: Mapping;
  profiles: { id: number; name: string }[];
}

interface Match {
  id: number;
  date: string;
  amount: number;
  category: string;
  vendor: string;
  reference: string;
  description: string;
  deleted: boolean;
  reason: string;
}

type Status = "new" | "duplicate" | "possible" | "error";

interface PreviewRow {
  line: number;
  status: Status;
  errors: string[];
  warnings: string[];
  date: string | null;
  amount: number | null;
  reference: string;
  vendor: string;
  description: string;
  category_id: number | null;
  category_source: "file" | "history" | "default" | null;
  subcategory: string;
  account: string;
  external_id: string | null;
  property_id: number | null;
  match: Match | null;
}

interface Preview {
  rows: PreviewRow[];
  summary: {
    total: number;
    new: number;
    duplicate: number;
    possible: number;
    error: number;
    money_in: number;
    money_out: number;
    from: string | null;
    to: string | null;
  };
}

interface ReviewRow extends PreviewRow {
  include: boolean;
}

interface ImportResult {
  created: number;
  duplicates: number;
  errors: number;
  audit_id: number | null;
}

type Step = "upload" | "map" | "review" | "done";
type Filter = "all" | Status | "uncategorized";

const OUTFLOW = /^(debit|dr|d|withdrawal|withdraw|charge|purchase|sale|out|fee|-)$/i;

/** Recompute amount_mode from which columns are mapped. */
function withAmountMode(m: Mapping): Mapping {
  const c = m.columns;
  const amount_mode = c.amount
    ? c.direction
      ? "direction"
      : "signed"
    : c.money_out || c.money_in
      ? "split"
      : "signed";
  return { ...m, amount_mode };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---------- page ----------

export default function ImportCsv() {
  const { overview, canWrite } = useSession();
  const toast = useToast();
  const [step, setStep] = useState<Step>("upload");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [info, setInfo] = useState<Inspection | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [propertyId, setPropertyId] = useState(overview.properties.find((p) => !p.archived)?.id ?? 0);
  const [windowDays, setWindowDays] = usePersistentState("csv-window-days", 3);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [saveProfile, setSaveProfile] = useState(true);
  const [profileName, setProfileName] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const inspect = async (t: string, opts: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const r = await api<Inspection>("import/inspect", { method: "POST", json: { text: t, ...opts } });
      setInfo(r);
      setMapping(r.mapping);
      setProfileName(r.profile?.name ?? "");
      setSaveProfile(!r.profile);
      setStep("map");
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const openFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.(csv|tsv|txt)$/i.test(f.name) && !/csv|text/.test(f.type))
      return toast({ text: "Choose a CSV file (export it from your bank or provider as CSV)", kind: "error" });
    const t = await f.text();
    setFileName(f.name);
    setText(t);
    setPreview(null);
    setResult(null);
    await inspect(t);
  };

  // Live preview while mapping (debounced): the same check the review step uses.
  const seq = useRef(0);
  useEffect(() => {
    if (step !== "map" || !mapping || !text) return;
    const n = ++seq.current;
    const timer = setTimeout(() => {
      api<Preview>("import/preview", {
        method: "POST",
        json: { text, mapping, property: propertyId || undefined, window_days: windowDays },
      })
        .then((p) => {
          if (n !== seq.current) return;
          setPreview(p);
          setPreviewError("");
        })
        .catch((e: Error) => {
          if (n !== seq.current) return;
          setPreview(null);
          setPreviewError(e.message);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [step, mapping, text, propertyId, windowDays]);

  const toReview = async () => {
    if (!preview || !mapping || !info) return;
    if (saveProfile && profileName.trim()) {
      try {
        await api("import/profiles", {
          method: "POST",
          json: { name: profileName.trim(), headers: info.headers, mapping },
        });
        toast({ text: `Saved settings as “${profileName.trim()}”`, kind: "ok" });
      } catch (e) {
        toast({ text: `Couldn't save the settings: ${(e as Error).message}`, kind: "error" });
      }
    }
    setRows(preview.rows.map((r) => ({ ...r, include: r.status === "new" })));
    setStep("review");
  };

  const reset = () => {
    setStep("upload");
    setText("");
    setInfo(null);
    setMapping(null);
    setPreview(null);
    setRows([]);
  };

  if (!canWrite) return <div className="page">Read-only accounts cannot import.</div>;

  return (
    <div className="page imp">
      <header className="page-head">
        <h1>Import transactions</h1>
        {step !== "upload" && step !== "done" && (
          <button className="btn" onClick={reset}>
            Start over
          </button>
        )}
      </header>

      <Stepper step={step} />

      {step === "upload" && <UploadStep busy={busy} onFile={(f) => void openFile(f)} />}

      {step === "map" && info && mapping && (
        <MapStep
          fileName={fileName}
          info={info}
          mapping={mapping}
          setMapping={setMapping}
          reinspect={(opts) => void inspect(text, opts)}
          preview={preview}
          previewError={previewError}
          propertyId={propertyId}
          setPropertyId={setPropertyId}
          windowDays={windowDays}
          setWindowDays={setWindowDays}
          saveProfile={saveProfile}
          setSaveProfile={setSaveProfile}
          profileName={profileName}
          setProfileName={setProfileName}
          onBack={reset}
          onNext={() => void toReview()}
        />
      )}

      {step === "review" && (
        <ReviewStep
          rows={rows}
          setRows={setRows}
          fileName={fileName}
          onBack={() => setStep("map")}
          onDone={(r) => {
            setResult(r);
            setStep("done");
          }}
        />
      )}

      {step === "done" && result && (
        <section className="card imp-done">
          <div className="imp-done-icon" aria-hidden>
            ✓
          </div>
          <h2>Imported {plural(result.created, "transaction")}</h2>
          {result.errors > 0 && <p className="neg">{plural(result.errors, "row")} could not be added.</p>}
          {result.duplicates > 0 && (
            <p className="neg">
              {plural(result.duplicates, "row")} skipped: the transaction ID is already in the ledger.
            </p>
          )}
          <p className="muted">From {fileName}. They're in your ledger now; anything flagged is on the To do page.</p>
          <div className="form-actions imp-done-actions">
            <Link className="btn primary" to="/transactions">
              View transactions
            </Link>
            <button className="btn" onClick={reset}>
              Import another file
            </button>
            {result.audit_id != null && (
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await api(`audit/${result.audit_id}/undo`, { method: "POST" });
                    toast({ text: `Removed the ${plural(result.created, "imported transaction")}`, kind: "ok" });
                    reset();
                  } catch (e) {
                    toast({ text: (e as Error).message, kind: "error" });
                  }
                }}
              >
                Undo import
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------- steps ----------

function Stepper({ step }: { step: Step }) {
  const steps: [Step, string][] = [
    ["upload", "Choose file"],
    ["map", "Match columns"],
    ["review", "Review & import"],
  ];
  const at = step === "done" ? 3 : steps.findIndex(([s]) => s === step);
  return (
    <ol className="imp-steps" aria-label="Import steps">
      {steps.map(([s, label], i) => (
        <li
          key={s}
          className={i < at ? "done" : i === at ? "current" : ""}
          aria-current={i === at ? "step" : undefined}
        >
          <span className="imp-step-num">{i < at ? "✓" : i + 1}</span>
          <span className="imp-step-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

function UploadStep({ busy, onFile }: { busy: boolean; onFile: (f: File | undefined) => void }) {
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    onFile(e.dataTransfer.files[0]);
  };
  return (
    <section className="card">
      <label
        className={`ms-drop imp-drop${over ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/plain"
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <span className="imp-drop-icon" aria-hidden>
          ⇪
        </span>
        <strong>{busy ? "Reading…" : "Drop a CSV export here, or click to choose"}</strong>
        <span className="muted small">Any bank, credit card, payment app or booking platform.</span>
      </label>
      <ul className="imp-points">
        <li>
          <strong>You choose the columns.</strong> The app guesses which column is which, and you can change any of
          them.
        </li>
        <li>
          <strong>Remembered per provider.</strong> Save the settings once; the next file with the same columns is set
          up for you.
        </li>
        <li>
          <strong>No double entries.</strong> Every row is checked against your ledger before anything is added.
        </li>
      </ul>
    </section>
  );
}

interface MapProps {
  fileName: string;
  info: Inspection;
  mapping: Mapping;
  setMapping: (m: Mapping) => void;
  reinspect: (opts: Record<string, unknown>) => void;
  preview: Preview | null;
  previewError: string;
  propertyId: number;
  setPropertyId: (n: number) => void;
  windowDays: number;
  setWindowDays: (n: number) => void;
  saveProfile: boolean;
  setSaveProfile: (b: boolean) => void;
  profileName: string;
  setProfileName: (s: string) => void;
  onBack: () => void;
  onNext: () => void;
}

function MapStep(p: MapProps) {
  const { overview } = useSession();
  const { info, mapping } = p;
  const fieldOf = (key: string) =>
    (Object.entries(mapping.columns).find(([, v]) => v === key)?.[0] as Field | undefined) ?? "";
  const assign = (key: string, field: Field | "") => {
    const columns = { ...mapping.columns };
    for (const [f, v] of Object.entries(columns)) if (v === key) delete columns[f as Field];
    if (field) columns[field] = key;
    let next = withAmountMode({ ...mapping, columns });
    if (field === "direction" && !next.outflow_values.length) {
      const vals = info.columns.find((c) => c.key === key)?.values ?? [];
      next = { ...next, outflow_values: vals.filter((v) => OUTFLOW.test(v)) };
    }
    p.setMapping(next);
  };
  const set = (patch: Partial<Mapping>) => p.setMapping({ ...mapping, ...patch });
  const dirCol = info.columns.find((c) => c.key === mapping.columns.direction);
  const missing = [
    !mapping.columns.date && "the date",
    !mapping.columns.amount && !mapping.columns.money_out && !mapping.columns.money_in && "the amount",
    mapping.amount_mode === "direction" && !mapping.outflow_values.length && "which type means money out",
  ].filter(Boolean);
  const s = p.preview?.summary;
  const sample = p.preview?.rows.slice(0, 6) ?? [];
  const usable = s ? s.total - s.error : 0;

  return (
    <>
      <section className="card">
        <div className="imp-file">
          <div>
            <strong className="ms-fname">{p.fileName}</strong>
            <div className="muted small">
              {plural(info.row_count, "row")} · {plural(info.columns.length, "column")}
              {info.preamble.length > 0 && ` · skipped ${plural(info.preamble.length, "line")} above the header`}
            </div>
          </div>
          <label className="imp-profile">
            Saved settings
            <select
              value={info.profile?.id ?? ""}
              onChange={(e) =>
                p.reinspect(
                  e.target.value
                    ? { profile_id: Number(e.target.value) }
                    : { delimiter: mapping.delimiter, header_row: mapping.header_row, has_header: mapping.has_header },
                )
              }
            >
              <option value="">{info.profiles.length ? "None (guess from headers)" : "None saved yet"}</option>
              {info.profiles.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {info.profile && (
          <p className="alert ok imp-matched">
            Recognized this layout: using your saved settings <strong>“{info.profile.name}”</strong>.
          </p>
        )}
        <details className="imp-advanced">
          <summary>File format</summary>
          <div className="imp-format">
            <label>
              Separator
              <select value={mapping.delimiter} onChange={(e) => p.reinspect({ delimiter: e.target.value })}>
                <option value=",">Comma ,</option>
                <option value=";">Semicolon ;</option>
                <option value={"\t"}>Tab</option>
                <option value="|">Pipe |</option>
              </select>
            </label>
            <label>
              Header is on line
              <input
                type="number"
                min={1}
                max={100}
                value={mapping.header_row + 1}
                onChange={(e) =>
                  p.reinspect({
                    delimiter: mapping.delimiter,
                    header_row: Math.max(0, Number(e.target.value) - 1),
                    has_header: mapping.has_header,
                  })
                }
              />
            </label>
            <label>
              Dates look like
              <select
                value={mapping.date_format}
                onChange={(e) => set({ date_format: e.target.value as Mapping["date_format"] })}
              >
                <option value="MDY">MM/DD/YYYY</option>
                <option value="DMY">DD/MM/YYYY</option>
                <option value="YMD">YYYY-MM-DD</option>
              </select>
            </label>
            <label>
              Numbers look like
              <select
                value={mapping.number_format}
                onChange={(e) => set({ number_format: e.target.value as Mapping["number_format"] })}
              >
                <option value="us">1,234.56</option>
                <option value="eu">1.234,56</option>
              </select>
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={mapping.has_header}
              onChange={(e) =>
                p.reinspect({
                  delimiter: mapping.delimiter,
                  header_row: mapping.header_row,
                  has_header: e.target.checked,
                })
              }
            />{" "}
            The file has a header row
          </label>
        </details>
      </section>

      <section className="card">
        <div className="section-head">
          <h2>Match columns</h2>
          <span className="muted small">Pick what each column holds. Leave the rest as “Don't import”.</span>
        </div>
        <div className="imp-cols">
          {info.columns.map((c) => {
            const f = fieldOf(c.key);
            return (
              <div key={c.key} className={`imp-col${f ? " on" : ""}`}>
                <div className="imp-col-head" title={c.label}>
                  {c.label}
                </div>
                <ul className="imp-col-samples">
                  {c.samples.slice(0, 3).map((v, i) => (
                    <li key={i} title={v}>
                      {v}
                    </li>
                  ))}
                  {!c.samples.length && <li className="muted">(empty)</li>}
                </ul>
                <select
                  value={f}
                  onChange={(e) => assign(c.key, e.target.value as Field | "")}
                  aria-label={`Use column ${c.label} as`}
                  title={f ? FIELDS[f].hint : ""}
                >
                  <option value="">Don't import</option>
                  {FIELD_GROUPS.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.fields.map((x) => (
                        <option key={x} value={x}>
                          {FIELDS[x].label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        {dirCol && (
          <fieldset className="field imp-direction">
            <legend>Which “{dirCol.label}” values mean money out?</legend>
            <div className="chips">
              {(dirCol.values ?? []).map((v) => {
                const on = mapping.outflow_values.some((x) => x.toLowerCase() === v.toLowerCase());
                return (
                  <button
                    key={v}
                    type="button"
                    className={`chip${on ? " on" : ""}`}
                    aria-pressed={on}
                    onClick={() =>
                      set({
                        outflow_values: on
                          ? mapping.outflow_values.filter((x) => x.toLowerCase() !== v.toLowerCase())
                          : [...mapping.outflow_values, v],
                      })
                    }
                  >
                    {v}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>Check the result</h2>
          {s && <span className="muted small">{s.from && s.to ? `${fmtDate(s.from)} – ${fmtDate(s.to)}` : ""}</span>}
        </div>
        {missing.length > 0 ? (
          <p className="alert warn">Choose {missing.join(" and ")} to continue.</p>
        ) : p.previewError ? (
          <p className="alert error">{p.previewError}</p>
        ) : !p.preview ? (
          <p className="muted">Reading…</p>
        ) : (
          <>
            <div className="imp-totals">
              <span>
                <strong className="pos">{money(s!.money_in)}</strong> <span className="muted">in</span>
              </span>
              <span>
                <strong className="neg">{money(s!.money_out)}</strong> <span className="muted">out</span>
              </span>
              <span className="muted">
                {plural(usable, "row")} ready{s!.error > 0 && <span className="neg"> · {s!.error} can't be read</span>}
              </span>
            </div>
            <table className="data-table imp-sample">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {sample.map((r) => (
                  <tr key={r.line}>
                    <td className="nowrap">{r.date ? fmtDate(r.date) : <span className="neg">?</span>}</td>
                    <td className="imp-desc">
                      {r.vendor || r.reference || r.description || <span className="muted">—</span>}
                    </td>
                    <td className={`num ${(r.amount ?? 0) < 0 ? "neg" : "pos"}`}>
                      {r.amount == null ? <span className="neg">?</span> : money(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sample.some((r) => r.errors.length) && (
              <p className="small neg">{sample.find((r) => r.errors.length)!.errors[0]}</p>
            )}
          </>
        )}
        <label className="check imp-flip">
          <input type="checkbox" checked={mapping.negate} onChange={(e) => set({ negate: e.target.checked })} /> Flip
          signs
          <span className="muted small">
            Money spent should show in red. Card exports often list charges as positive.
          </span>
        </label>

        <div className="imp-options">
          {!mapping.columns.account && (
            <label>
              Account
              <input
                value={mapping.account}
                onChange={(e) => set({ account: e.target.value })}
                placeholder="e.g. Checking, Visa"
              />
            </label>
          )}
          {overview.properties.length > 1 && !mapping.columns.property && (
            <label>
              Property
              <select value={p.propertyId} onChange={(e) => p.setPropertyId(Number(e.target.value))}>
                {overview.properties.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Possible match window
            <select value={p.windowDays} onChange={(e) => p.setWindowDays(Number(e.target.value))}>
              <option value={0}>Same day only</option>
              {[1, 2, 3, 5, 7].map((n) => (
                <option key={n} value={n}>
                  ± {plural(n, "day")}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="imp-save">
          <label className="check">
            <input type="checkbox" checked={p.saveProfile} onChange={(e) => p.setSaveProfile(e.target.checked)} />{" "}
            {info.profile ? "Update the saved settings" : "Remember these settings for this provider"}
          </label>
          {p.saveProfile && (
            <input
              value={p.profileName}
              onChange={(e) => p.setProfileName(e.target.value)}
              placeholder="Name, e.g. Chase checking"
              aria-label="Settings name"
            />
          )}
        </div>

        <div className="form-actions">
          <button className="btn" onClick={p.onBack}>
            Back
          </button>
          <span className="spacer" />
          <button
            className="btn primary"
            disabled={!p.preview || missing.length > 0 || usable === 0 || (p.saveProfile && !p.profileName.trim())}
            onClick={p.onNext}
            title={p.saveProfile && !p.profileName.trim() ? "Name the saved settings, or untick the box" : ""}
          >
            Check {plural(usable, "row")} against the ledger →
          </button>
        </div>
      </section>
    </>
  );
}

function ReviewStep({
  rows,
  setRows,
  fileName,
  onBack,
  onDone,
}: {
  rows: ReviewRow[];
  setRows: (fn: (rs: ReviewRow[]) => ReviewRow[]) => void;
  fileName: string;
  onBack: () => void;
  onDone: (r: ImportResult) => void;
}) {
  const { overview, reloadOverview } = useSession();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [flagReview, setFlagReview] = usePersistentState("csv-flag-review", true);
  const [busy, setBusy] = useState(false);
  const [openTx, setOpenTx] = useState<number | null>(null);
  const income = overview.categories.filter((c) => c.kind === "income" && !c.archived);
  const expense = overview.categories.filter((c) => c.kind === "expense" && !c.archived);

  const count = (f: Filter) =>
    f === "all"
      ? rows.length
      : f === "uncategorized"
        ? rows.filter((r) => r.include && !r.category_id).length
        : rows.filter((r) => r.status === f).length;
  const visible = useMemo(
    () =>
      rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) =>
          filter === "all" ? true : filter === "uncategorized" ? r.include && !r.category_id : r.status === filter,
        ),
    [rows, filter],
  );
  const included = rows.filter((r) => r.include);
  const needCategory = included.filter((r) => !r.category_id).length;
  const selectable = visible.filter(({ r }) => r.status !== "error");
  const allOn = selectable.length > 0 && selectable.every(({ r }) => r.include);

  const update = (i: number, patch: Partial<ReviewRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setVisible = (patch: (r: ReviewRow) => Partial<ReviewRow>) => {
    const idx = new Set(selectable.map(({ i }) => i));
    setRows((rs) => rs.map((r, j) => (idx.has(j) ? { ...r, ...patch(r) } : r)));
  };

  const commit = async () => {
    setBusy(true);
    try {
      const res = await api<
        ImportResult & {
          results: { index: number; status: string; error?: string }[];
        }
      >("import/commit", {
        method: "POST",
        json: {
          transactions: included.map((r) => ({
            property_id: r.property_id,
            date: r.date,
            amount: r.amount,
            category_id: r.category_id,
            subcategory: r.subcategory,
            vendor: r.vendor,
            reference: r.reference,
            description: r.description,
            account: r.account,
            external_id: r.external_id ?? undefined,
            needs_review: flagReview,
            review_note: flagReview
              ? `Imported from ${fileName}${r.match ? ` (looked like #${r.match.id}, ${r.match.reason})` : ""}`
              : "",
            refund: true, // the bank decides the sign
          })),
        },
      });
      void reloadOverview();
      if (res.errors && !res.created) {
        const first = res.results.find((x) => x.status !== "created");
        toast({ text: first?.error ?? "Nothing was imported", kind: "error" });
        return;
      }
      onDone(res);
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const filters: [Filter, string, string][] = [
    ["all", "All", ""],
    ["new", "New", "ok"],
    ["possible", "Possible match", "warn"],
    ["duplicate", "Already in ledger", "muted"],
    ["error", "Can't import", "err"],
  ];
  if (needCategory) filters.push(["uncategorized", "Needs category", "warn"]);

  return (
    <>
      <div className="imp-tiles">
        {filters
          .filter(([f]) => f === "all" || count(f) > 0)
          .map(([f, label, tone]) => (
            <button
              key={f}
              className={`imp-tile ${tone}${filter === f ? " on" : ""}`}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
            >
              <span className="imp-tile-value">{count(f)}</span>
              <span className="imp-tile-label">{label}</span>
            </button>
          ))}
      </div>
      {count("possible") > 0 && filter !== "possible" && (
        <p className="alert warn">
          {plural(count("possible"), "row")} look like {count("possible") === 1 ? "a transaction" : "transactions"}{" "}
          already in the ledger (same amount, close date). They're left out; tick any that are really new.
        </p>
      )}

      <section className="card table-card">
        <div className="imp-bulk">
          <label className="check">
            <input
              type="checkbox"
              checked={allOn}
              onChange={(e) => setVisible(() => ({ include: e.target.checked }))}
              disabled={!selectable.length}
            />{" "}
            Select all shown
          </label>
          <span className="spacer" />
          <select
            value=""
            onChange={(e) => {
              const id = Number(e.target.value);
              if (id) setVisible((r) => (r.include ? { category_id: id } : {}));
            }}
            aria-label="Set category for selected rows"
            className="imp-bulk-cat"
          >
            <option value="">Set category for selected…</option>
            <optgroup label="Expenses">
              {expense.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Income">
              {income.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <table className="data-table imp-table">
          <thead>
            <tr>
              <th aria-label="Import" />
              <th>Date</th>
              <th>Description</th>
              <th>Category</th>
              <th className="num">Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ r, i }) => {
              const cats = (r.amount ?? 0) > 0 ? [income, expense] : [expense, income];
              return (
                <tr key={r.line} className={r.include ? "" : "excluded"}>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.include}
                      disabled={r.status === "error"}
                      onChange={(e) => update(i, { include: e.target.checked })}
                      aria-label={`Import line ${r.line}`}
                    />
                  </td>
                  <td className="nowrap">{r.date ? fmtDate(r.date) : "—"}</td>
                  <td className="imp-desc">
                    <input
                      className="cell-input wide"
                      value={r.vendor}
                      placeholder="Vendor"
                      onChange={(e) => update(i, { vendor: e.target.value })}
                      aria-label="Vendor"
                    />
                    <div className="muted small imp-ref" title={r.reference}>
                      {r.reference}
                      {r.description && ` · ${r.description}`}
                    </div>
                  </td>
                  <td>
                    <select
                      className={r.include && !r.category_id ? "imp-need" : ""}
                      value={r.category_id ?? ""}
                      onChange={(e) => update(i, { category_id: Number(e.target.value) || null })}
                      aria-label="Category"
                      disabled={r.status === "error"}
                    >
                      <option value="">Choose…</option>
                      {cats[0]!.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                      <optgroup label="Other type">
                        {cats[1]!.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    {r.subcategory && <div className="muted small">{r.subcategory}</div>}
                  </td>
                  <td className={`num ${(r.amount ?? 0) < 0 ? "neg" : "pos"}`}>
                    {r.amount == null ? "—" : money(r.amount)}
                  </td>
                  <td className="imp-status">
                    <StatusCell row={r} onOpen={setOpenTx} />
                  </td>
                </tr>
              );
            })}
            {!visible.length && (
              <tr>
                <td colSpan={6} className="empty">
                  Nothing here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="form-actions">
          <button className="btn" onClick={onBack}>
            ← Columns
          </button>
          <label className="check imp-flag">
            <input type="checkbox" checked={flagReview} onChange={(e) => setFlagReview(e.target.checked)} /> Flag for
            review
          </label>
          <span className="spacer" />
          {needCategory > 0 && (
            <button className="link small neg" onClick={() => setFilter("uncategorized")}>
              {plural(needCategory, "row")} need a category
            </button>
          )}
          <button
            className="btn primary"
            disabled={busy || !included.length || needCategory > 0}
            onClick={() => void commit()}
          >
            {busy ? "Importing…" : `Import ${plural(included.length, "transaction")}`}
          </button>
        </div>
      </section>
      {openTx != null && <TxEditModal id={openTx} onClose={() => setOpenTx(null)} onChanged={() => {}} />}
    </>
  );
}

function StatusCell({ row: r, onOpen }: { row: ReviewRow; onOpen: (id: number) => void }) {
  if (r.status === "error")
    return (
      <>
        <span className="badge err">Can't import</span>
        <div className="small neg">{r.errors.join("; ")}</div>
      </>
    );
  const m = r.match;
  return (
    <>
      {r.status === "new" && <span className="badge ok">New</span>}
      {r.status === "duplicate" && <span className="badge muted">Already in ledger</span>}
      {r.status === "possible" && <span className="badge warn">Possible match</span>}
      {r.category_source === "history" && r.status === "new" && (
        <span className="badge muted" title="Category from earlier transactions with this vendor">
          auto
        </span>
      )}
      {m && (
        <div className="small imp-match">
          {m.deleted ? (
            <span className="muted">#{m.id} (deleted)</span>
          ) : (
            <button className="link small" onClick={() => onOpen(m.id)}>
              #{m.id}
            </button>
          )}{" "}
          <span className="muted">
            {fmtDate(m.date)} · {m.vendor || m.reference || m.category} · {m.reason}
          </span>
        </div>
      )}
      {r.warnings.map((w) => (
        <div key={w} className="small muted">
          {w}
        </div>
      ))}
    </>
  );
}
