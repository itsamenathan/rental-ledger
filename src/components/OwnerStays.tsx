import { useState } from "react";
import { api } from "../api.ts";
import { monthTitle } from "../format.ts";
import { useApi, useSession, useToast } from "../hooks.ts";
import TodoRow from "./TodoRow.tsx";
import {
  kindLabel,
  plural,
  rangeLabel,
  saveOwnerStay,
  STAY_KINDS,
  type MonthCompare,
  type OwnerStay,
  type StayCandidate,
  type StayKind,
} from "../owner-stays.ts";

/** Who stayed: one tap instead of a dropdown. */
function KindToggle({
  value,
  onChange,
  small = false,
}: {
  value: StayKind;
  onChange: (v: StayKind) => void;
  small?: boolean;
}) {
  return (
    <div className={small ? "segmented small" : "segmented"} role="radiogroup" aria-label="Who stayed">
      {STAY_KINDS.map((k) => (
        <button
          key={k.value}
          type="button"
          role="radio"
          aria-checked={value === k.value}
          className={value === k.value ? "on" : ""}
          onClick={() => onChange(k.value)}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}

/** Run an action, show its error as a toast, then call onChange. */
function useRun(onChange: () => void) {
  const toast = useToast();
  return async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChange();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
}

/** Blocked calendar ranges with "Yes, we stayed" / "Not a stay" (To do page and the Occupancy page's list). */
export function CandidateList({
  items,
  onChange,
  showReason = false,
}: {
  items: (StayCandidate & { property_id: number; property?: string })[];
  onChange: () => void;
  showReason?: boolean;
}) {
  const { canWrite } = useSession();
  const toast = useToast();
  const run = useRun(onChange);
  const [kinds, setKinds] = useState<Record<string, StayKind>>({});
  const keyOf = (c: { property_id: number; start_date: string; end_date: string }) =>
    `${c.property_id}/${c.start_date}/${c.end_date}`;
  return (
    <ul className="todo-list">
      {items.map((c) => (
        <TodoRow
          key={keyOf(c)}
          title={rangeLabel(c)}
          property={c.property}
          note={showReason ? c.reason : `Blocked on ${c.blocked_on.join(" and ")} with no guest booked`}
        >
          {canWrite && (
            <>
              <KindToggle
                small
                value={kinds[keyOf(c)] ?? "owner"}
                onChange={(v) => setKinds((k) => ({ ...k, [keyOf(c)]: v }))}
              />
              <button
                className="btn small primary"
                onClick={() =>
                  void run(() =>
                    saveOwnerStay(toast, {
                      property_id: c.property_id,
                      start_date: c.start_date,
                      end_date: c.end_date,
                      kind: kinds[keyOf(c)] ?? "owner",
                    }),
                  )
                }
              >
                Add stay
              </button>
              <button
                className="btn small ghost"
                onClick={() =>
                  void run(() =>
                    api("owner-stays/dismissals", {
                      method: "POST",
                      json: { property_id: c.property_id, start_date: c.start_date, end_date: c.end_date },
                    }),
                  )
                }
              >
                Not a stay
              </button>
            </>
          )}
        </TodoRow>
      ))}
    </ul>
  );
}

/** Months where the calendar's guest nights differ from the saved ones, with "Use calendar" (To do page). */
export function GuestNightList({
  items,
  onChange,
}: {
  items: (MonthCompare & { property_id: number; property?: string })[];
  onChange: () => void;
}) {
  const { canWrite } = useSession();
  const toast = useToast();
  const run = useRun(onChange);
  const apply = (m: MonthCompare & { property_id: number }) => {
    if (
      m.calendar_lower &&
      !confirm(
        `The calendar has fewer nights than you entered for ${monthTitle(m.month)}. Direct bookings aren't on the calendar. Use the calendar's numbers anyway?`,
      )
    )
      return;
    void run(async () => {
      const r = await api<{ applied: unknown[]; skipped: { reason: string }[] }>("occupancy/calendar/apply", {
        method: "POST",
        json: { property_id: m.property_id, months: [m.month], confirm_lower: m.calendar_lower },
      });
      if (r.applied.length) toast({ text: `${monthTitle(m.month)} updated from the calendar`, kind: "ok" });
      for (const s of r.skipped) toast({ text: s.reason, kind: "error" });
    });
  };
  return (
    <ul className="todo-list">
      {items.map((m) => (
        <TodoRow
          key={`${m.property_id}/${m.month}`}
          title={monthTitle(m.month)}
          property={m.property}
          note={
            <>
              Calendar: {plural(m.calendar!.nights_booked, "night")}, {plural(m.calendar!.check_ins, "check-in")}. You
              entered:{" "}
              {m.stored
                ? `${plural(m.stored.nights_booked, "night")}, ${plural(m.stored.check_ins, "check-in")}.`
                : "nothing yet."}
            </>
          }
        >
          {canWrite && (
            <button className="btn small primary" onClick={() => apply(m)}>
              Use calendar
            </button>
          )}
        </TodoRow>
      ))}
    </ul>
  );
}

/** The year's owner stays: list, add form, personal-day total, and blocked calendar dates to pick from. */
export function OwnerStaysPanel({
  propertyId,
  year,
  stays,
  personalDays,
  rentalDays,
  onChange,
}: {
  propertyId: number;
  year: number;
  stays: OwnerStay[] | null;
  personalDays: number;
  rentalDays: number;
  onChange: () => void;
}) {
  const { canWrite } = useSession();
  const toast = useToast();
  const run = useRun(onChange);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [kind, setKind] = useState<StayKind>("owner");
  const [showBlocks, setShowBlocks] = useState(false);
  const [version, setVersion] = useState(0);
  const blocks = useApi<{ candidates: StayCandidate[] }>(
    showBlocks ? `owner-stays/candidates?year=${year}&property_id=${propertyId}&v=${version}` : null,
  );
  const changed = () => {
    setVersion((v) => v + 1);
    onChange();
  };
  const limit = Math.max(14, Math.floor(rentalDays * 0.1));

  const add = () =>
    run(async () => {
      await saveOwnerStay(toast, { property_id: propertyId, start_date: start, end_date: end, kind });
      setStart("");
      setEnd("");
    });
  const remove = (s: OwnerStay) => {
    if (confirm(`Delete the owner stay ${rangeLabel(s)}?`))
      void run(() => api(`owner-stays/${s.id}`, { method: "DELETE" }));
  };

  return (
    <section className="card" aria-labelledby="owner-stays-h">
      <div className="section-head">
        <h2 id="owner-stays-h">Owner stays</h2>
        <span className={personalDays > limit ? "badge warn" : "badge muted"}>
          {personalDays} of {limit} personal days
        </span>
      </div>
      <p className="muted small">
        Personal use: you, family, or below-market rent. Months with a stay take their personal nights from it.
        {personalDays > limit && " Over the limit: the home counts as a residence (see Taxes)."}
      </p>
      {stays && stays.length > 0 && (
        <ul className="plain-list owner-stay-list">
          {stays.map((s) => (
            <li key={s.id}>
              <span>
                {rangeLabel(s)}
                {s.nights_in_year !== s.nights && (
                  <span className="muted">
                    {" "}
                    · {s.nights_in_year} in {year}
                  </span>
                )}
                {s.kind && <span className="muted"> · {kindLabel(s.kind)}</span>}
              </span>
              {canWrite && (
                <button className="link small" onClick={() => remove(s)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form
          className="owner-stay-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="field">
            <span>Arrive</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
          </label>
          <label className="field">
            <span>Leave</span>
            <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} required />
          </label>
          <div className="field">
            <span>Who</span>
            <KindToggle value={kind} onChange={setKind} />
          </div>
          <button className="btn primary" disabled={!start || !end}>
            Add stay
          </button>
        </form>
      )}
      <button className="link small owner-stay-blocks" onClick={() => setShowBlocks((v) => !v)}>
        {showBlocks ? "Hide blocked calendar dates" : "Pick from blocked calendar dates"}
      </button>
      {showBlocks && blocks.data && (
        <>
          {blocks.data.candidates.length === 0 ? (
            <p className="muted small">No blocked dates without a guest in {year}.</p>
          ) : (
            <CandidateList
              items={blocks.data.candidates.map((c) => ({ ...c, property_id: propertyId }))}
              onChange={changed}
              showReason
            />
          )}
        </>
      )}
    </section>
  );
}
