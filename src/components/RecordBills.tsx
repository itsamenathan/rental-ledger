import { useState } from "react";
import { api, type ChecklistItem } from "../api.ts";
import { fmtDate, monthTitle } from "../format.ts";
import { useToast } from "../hooks.ts";
import { Modal } from "../lib.tsx";

interface Row {
  item: ChecklistItem;
  on: boolean;
  amount: string;
  date: string;
}

/** Record a month's expected recurring bills in one go. Fixed-amount bills are pre-checked. */
export default function RecordBills({
  ym,
  items,
  onClose,
  onDone,
}: {
  ym: string;
  items: ChecklistItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>(() =>
    items
      .filter((i) => i.kind === "expense" && (i.state === "missing" || i.state === "upcoming"))
      .map((item) => ({
        item,
        on: item.fixed_amount,
        amount: Math.abs(item.typical_amount).toFixed(2),
        date: item.expected_date,
      })),
  );
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.on);
  const total = chosen.reduce((a, r) => a + (Number(r.amount) || 0), 0);

  const save = async () => {
    const bad = chosen.find((r) => !(Number(r.amount) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date));
    if (bad) return toast({ text: `Check the amount and date for ${bad.item.label}`, kind: "error" });
    setBusy(true);
    try {
      const r = await api<{ created: number; duplicates: number }>("transactions/bulk", {
        method: "POST",
        json: {
          skip_duplicates: true,
          transactions: chosen.map(({ item, amount, date }) => ({
            date,
            amount: (item.kind === "expense" ? -1 : 1) * Number(amount),
            category_id: item.category_id,
            property_id: item.property_id,
            subcategory: item.subcategory,
            vendor: item.vendor,
            allocation: item.kind === "expense" ? item.allocation : null,
          })),
        },
      });
      toast({
        text:
          `Recorded ${r.created} ${r.created === 1 ? "entry" : "entries"}` +
          (r.duplicates ? ` (${r.duplicates} already there, skipped)` : ""),
        kind: "ok",
      });
      onDone();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Record bills for ${monthTitle(ym)}`} onClose={onClose} wide>
      {rows.length === 0 ? (
        <p className="muted">Everything expected for this month is already recorded.</p>
      ) : (
        <>
          <p className="muted small">
            Bills that are the same every time are ticked. Ones that vary show the usual amount; tick them and type the
            real amount from the bill.
          </p>
          <ul className="record-list">
            {rows.map((r, i) => (
              <li key={r.item.series_key} className={r.on ? "" : "off"}>
                <label className="check record-name">
                  <input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} />
                  <span>
                    {r.item.label}
                    <small className="muted">
                      {" "}
                      · {r.item.fixed_amount ? "same every time" : "varies"} · usually around{" "}
                      {fmtDate(r.item.expected_date).replace(/, \d{4}$/, "")}
                    </small>
                  </span>
                </label>
                <input
                  type="date"
                  value={r.date}
                  onChange={(e) => set(i, { date: e.target.value, on: true })}
                  aria-label={`Date for ${r.item.label}`}
                />
                <div className="input-prefix">
                  <span>$</span>
                  <input
                    inputMode="decimal"
                    value={r.amount}
                    onChange={(e) => set(i, { amount: e.target.value, on: true })}
                    aria-label={`Amount for ${r.item.label}`}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="form-actions">
        <span className="muted small">
          {chosen.length
            ? `${chosen.length} selected · $${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
            : ""}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || chosen.length === 0} onClick={() => void save()}>
          {busy ? "Saving…" : `Record ${chosen.length || ""}`.trim()}
        </button>
      </div>
    </Modal>
  );
}
