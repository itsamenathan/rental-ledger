import { useState } from "react";
import { api } from "../api.ts";
import { monthLabel } from "../format.ts";
import { useApi, useSession, useToast } from "../hooks.ts";
import {
  dayLabel,
  kindLabel,
  plural,
  rangeLabel,
  saveOwnerStay,
  STAY_KINDS,
  type OwnerStay,
  type StayKind,
} from "../owner-stays.ts";

interface Candidate {
  start_date: string;
  end_date: string;
  nights: number;
  nights_in_year: number;
  blocked_on: string[];
  covering: string[];
  signal: "strong" | "unclear" | "weak";
  reason: string;
}

interface Candidates {
  candidates: Candidate[];
  dismissed: { id: number; start_date: string; end_date: string }[];
}

interface MonthCompare {
  month: string;
  status: "not_ended" | "no_data" | "match" | "differs";
  calendar: { nights_booked: number; check_ins: number } | null;
  stored: { nights_booked: number; check_ins: number } | null;
  calendar_lower: boolean;
  incomplete: string[];
}

function KindSelect({ value, onChange }: { value: StayKind | ""; onChange: (v: StayKind | "") => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as StayKind | "")} aria-label="Kind of stay">
      <option value="">Kind (optional)</option>
      {STAY_KINDS.map((k) => (
        <option key={k.value} value={k.value}>
          {k.label}
        </option>
      ))}
    </select>
  );
}

/** Personal-use stays by date for the year, with the add form and the personal-use total vs the 14-day / 10% line. */
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
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [kind, setKind] = useState<StayKind | "">("");
  const [note, setNote] = useState("");
  const limit = Math.max(14, Math.floor(rentalDays * 0.1));
  const fromStays = (stays ?? []).reduce((a, s) => a + s.nights_in_year, 0);

  const add = async () => {
    try {
      await saveOwnerStay(toast, {
        property_id: propertyId,
        start_date: start,
        end_date: end,
        kind: kind || null,
        note,
      });
      setStart("");
      setEnd("");
      setKind("");
      setNote("");
      onChange();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  const remove = async (s: OwnerStay) => {
    if (!confirm(`Delete the owner stay ${rangeLabel(s)}?`)) return;
    try {
      await api(`owner-stays/${s.id}`, { method: "DELETE" });
      onChange();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };

  return (
    <section className="card" aria-labelledby="owner-stays-h">
      <div className="section-head">
        <h2 id="owner-stays-h">Owner stays</h2>
        <span className={personalDays > limit ? "badge warn" : "badge muted"}>
          {plural(personalDays, "personal day")} in {year}
        </span>
      </div>
      <p className="muted small">
        Nights you, family or anyone paying below-market rent stayed. For a month with a stay, its personal nights come
        from these dates (the column is locked in the table below); other months keep the number you typed. The checkout
        day isn&apos;t counted, and a stay across New Year counts in each year by night.
      </p>
      <p className="small">
        {fromStays > 0 && fromStays !== personalDays && (
          <>
            {plural(fromStays, "day")} from the stays below, {personalDays - fromStays} typed in for other months.{" "}
          </>
        )}
        Personal use stays under the limit while it&apos;s at most the greater of 14 days or 10% of rental days:{" "}
        <strong>{limit} days</strong> for {plural(rentalDays, "rental night")}.
        {personalDays > limit && (
          <strong> Over the limit: the property counts as a residence (see the tax report).</strong>
        )}
      </p>
      {stays && stays.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Dates (first night – checkout)</th>
              <th className="num">Nights</th>
              <th>Kind</th>
              <th className="hide-sm">Note</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {stays.map((s) => (
              <tr key={s.id}>
                <td className="nowrap">{rangeLabel(s)}</td>
                <td className="num">
                  {s.nights_in_year}
                  {s.nights_in_year !== s.nights && <span className="muted small"> of {s.nights}</span>}
                </td>
                <td>{kindLabel(s.kind)}</td>
                <td className="hide-sm muted">{s.note}</td>
                {canWrite && (
                  <td className="num">
                    <button className="link small" onClick={() => void remove(s)}>
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {stays && stays.length === 0 && <p className="muted small">No owner stays entered for {year}.</p>}
      {canWrite && (
        <form
          className="inline-form owner-stay-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="small">
            First night <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
          </label>
          <label className="small">
            Checkout <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} required />
          </label>
          <KindSelect value={kind} onChange={setKind} />
          <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn primary small" disabled={!start || !end}>
            Add stay
          </button>
        </form>
      )}
    </section>
  );
}

const SIGNAL: Record<Candidate["signal"], { label: string; cls: string }> = {
  strong: { label: "Likely owner", cls: "badge ok" },
  unclear: { label: "Can't tell", cls: "badge muted" },
  weak: { label: "Less likely", cls: "badge muted" },
};

/** Blocked calendar ranges that may be owner stays. Nothing counts until confirmed. */
export function StaysToConfirm({
  propertyId,
  year,
  version,
  onChange,
}: {
  propertyId: number;
  year: number;
  /** bump to reload (onChange does after every action here) */
  version: number;
  onChange: () => void;
}) {
  const { canWrite } = useSession();
  const toast = useToast();
  const { data } = useApi<Candidates>(`owner-stays/candidates?year=${year}&property_id=${propertyId}&v=${version}`);
  const [kinds, setKinds] = useState<Record<string, StayKind | "">>({});
  const [showAll, setShowAll] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  if (!data || (!data.candidates.length && !data.dismissed.length)) return null;

  const strong = data.candidates.filter((c) => c.signal === "strong");
  const rest = data.candidates.filter((c) => c.signal !== "strong");
  const shown = showAll ? data.candidates : strong;
  const keyOf = (c: { start_date: string; end_date: string }) => `${c.start_date}/${c.end_date}`;

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChange();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  const confirmStay = (c: Candidate) =>
    run(() =>
      saveOwnerStay(toast, {
        property_id: propertyId,
        start_date: c.start_date,
        end_date: c.end_date,
        kind: kinds[keyOf(c)] || null,
      }),
    );
  const dismiss = (c: Candidate) =>
    run(() =>
      api("owner-stays/dismissals", {
        method: "POST",
        json: { property_id: propertyId, start_date: c.start_date, end_date: c.end_date },
      }),
    );
  const restore = (id: number) => run(() => api(`owner-stays/dismissals/${id}`, { method: "DELETE" }));

  return (
    <section className="card" aria-labelledby="stays-confirm-h">
      <div className="section-head">
        <h2 id="stays-confirm-h">
          Owner stays to confirm {strong.length > 0 && <span className="nav-count inline">{strong.length}</span>}
        </h2>
      </div>
      <p className="muted small">
        Dates blocked on your booking calendars with no guest reservation. A block on every calendar is most likely your
        own stay; one on a single calendar may be another platform&apos;s guest. They don&apos;t count as personal days
        until you confirm them.
      </p>
      {shown.length > 0 && (
        <ul className="todo-list">
          {shown.map((c) => (
            <li key={keyOf(c)}>
              <div className="todo-main as-text">
                <span className="todo-what">
                  <strong>{rangeLabel(c)}</strong>{" "}
                  <span className={SIGNAL[c.signal].cls}>{SIGNAL[c.signal].label}</span>
                </span>
                <span className="todo-note">
                  {c.reason}
                  {c.nights_in_year !== c.nights && ` · ${c.nights_in_year} in ${year}`}
                </span>
              </div>
              <span />
              {canWrite && (
                <span className="todo-actions">
                  <KindSelect
                    value={kinds[keyOf(c)] ?? ""}
                    onChange={(v) => setKinds((k) => ({ ...k, [keyOf(c)]: v }))}
                  />
                  <button className="btn small primary" onClick={() => void confirmStay(c)}>
                    Yes, we stayed
                  </button>
                  <button className="btn small" onClick={() => void dismiss(c)}>
                    Not a stay
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="small">
        {!strong.length && !showAll && rest.length > 0 && (
          <span className="muted">No dates look like a likely owner stay. </span>
        )}
        {rest.length > 0 && (
          <button className="link small" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show only likely owner stays" : `Show ${rest.length} less certain`}
          </button>
        )}
        {data.dismissed.length > 0 && (
          <>
            {" "}
            <button className="link small" onClick={() => setShowDismissed((v) => !v)}>
              {showDismissed ? "Hide" : "Show"} {data.dismissed.length} marked not a stay
            </button>
          </>
        )}
      </p>
      {rest.some((c) => c.signal === "unclear") && showAll && (
        <p className="muted small">
          Older dates seen on only one calendar are often a guest from another platform whose own calendar no longer
          goes back that far. Importing Airbnb&apos;s reservations CSV (property settings) rules those out.
        </p>
      )}
      {showDismissed && (
        <ul className="plain-list small">
          {data.dismissed.map((d) => (
            <li key={d.id}>
              {dayLabel(d.start_date)} – {dayLabel(d.end_date)}{" "}
              {canWrite && (
                <button className="link small" onClick={() => void restore(d.id)}>
                  Suggest again
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Ended months where the calendar's guest nights differ from the saved ones, with "Use calendar numbers". */
export function GuestNightsPanel({
  propertyId,
  year,
  version,
  onChange,
}: {
  propertyId: number;
  year: number;
  /** bump to reload (onChange does after applying) */
  version: number;
  onChange: () => void;
}) {
  const { canWrite } = useSession();
  const toast = useToast();
  const { data } = useApi<{ months: MonthCompare[]; differing: string[] }>(
    `occupancy/calendar?year=${year}&property_id=${propertyId}&v=${version}`,
  );
  const [showPartial, setShowPartial] = useState(false);
  if (!data) return null;
  const all = data.months.filter((m) => m.status === "differs");
  // months where a connected calendar doesn't reach back: its stays are probably just missing
  const partial = all.filter((m) => m.incomplete.length);
  const differs = all.filter((m) => !m.incomplete.length);
  const noData = data.months.filter((m) => m.status === "no_data");
  if (!all.length) return null;
  const higher = differs.filter((m) => !m.calendar_lower);
  const shown = showPartial ? [...differs, ...partial] : differs;
  const missingFeeds = [...new Set(partial.flatMap((m) => m.incomplete))];

  const apply = async (months: MonthCompare[], confirmLower: boolean) => {
    try {
      const r = await api<{ applied: { month: string }[]; skipped: { month: string; reason: string }[] }>(
        "occupancy/calendar/apply",
        {
          method: "POST",
          json: { property_id: propertyId, months: months.map((m) => m.month), confirm_lower: confirmLower },
        },
      );
      if (r.applied.length)
        toast({ text: `Updated ${plural(r.applied.length, "month")} from the calendar`, kind: "ok" });
      for (const s of r.skipped) toast({ text: `${monthLabel(s.month, "long")}: ${s.reason}`, kind: "error" });
      onChange();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  const applyOne = (m: MonthCompare) => {
    if (
      m.calendar_lower &&
      !confirm(
        `The calendar has fewer nights for ${monthLabel(m.month, "long")} (${m.calendar!.nights_booked}) than you entered (${m.stored!.nights_booked}). Direct or off-platform bookings aren't on the calendar. Use the calendar's numbers anyway?`,
      )
    )
      return;
    void apply([m], m.calendar_lower);
  };

  return (
    <section className="card" aria-labelledby="guest-nights-h">
      <div className="section-head">
        <h2 id="guest-nights-h">
          Guest nights {differs.length > 0 && <span className="nav-count inline">{differs.length}</span>}
        </h2>
        {canWrite && higher.length > 1 && (
          <button className="btn small" onClick={() => void apply(higher, false)}>
            Use calendar numbers for {higher.length} months
          </button>
        )}
      </div>
      <p className="muted small">
        Months that have ended where your booking calendars disagree with what you entered. Nothing changes until you
        click. Keep yours when the calendar is short because of direct bookings it doesn&apos;t know about.
      </p>
      <ul className="todo-list">
        {shown.map((m) => (
          <li key={m.month}>
            <div className="todo-main as-text">
              <span className="todo-what">
                <strong>{monthLabel(m.month, "long")}</strong>
                {m.calendar_lower && <span className="badge warn">Calendar lower</span>}
                {m.incomplete.length > 0 && <span className="badge muted">Calendar incomplete</span>}
              </span>
              <span className="todo-note">
                Calendar says {plural(m.calendar!.nights_booked, "night")} and{" "}
                {plural(m.calendar!.check_ins, "check-in")};{" "}
                {m.stored
                  ? `you entered ${plural(m.stored.nights_booked, "night")} and ${plural(m.stored.check_ins, "check-in")}`
                  : "nothing entered yet"}
              </span>
            </div>
            <span />
            {canWrite && (
              <span className="todo-actions">
                <button className={m.calendar_lower ? "btn small" : "btn small primary"} onClick={() => applyOne(m)}>
                  Use calendar numbers
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {partial.length > 0 && (
        <p className="small">
          <span className="muted">
            {plural(partial.length, differs.length ? "more month" : "month")} differ where {missingFeeds.join(" and ")}{" "}
            doesn&apos;t go back far enough, so its stays are missing from the calendar. Importing Airbnb&apos;s
            reservations CSV (property settings) fills them in.{" "}
          </span>
          <button className="link small" onClick={() => setShowPartial((v) => !v)}>
            {showPartial ? "Hide them" : "Show them"}
          </button>
        </p>
      )}
      {noData.length > 0 && (
        <p className="muted small">
          No calendar reservations for {noData.map((m) => monthLabel(m.month)).join(", ")}: nothing to compare.
        </p>
      )}
    </section>
  );
}
