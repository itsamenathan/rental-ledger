import { Fragment, useState } from "react";
import { api } from "../api.ts";
import { fmtDate, monthLabel, percent, THIS_YEAR } from "../format.ts";
import { useApi, usePersistentState, useScopedPath, useSession, useToast, useProperty } from "../hooks.ts";
import { YearSelect } from "../lib.tsx";
import { Link, useSearchParams } from "react-router";
import { OwnerStaysPanel } from "../components/OwnerStays.tsx";
import { plural, type MonthCompare, type OwnerStay } from "../owner-stays.ts";

interface Row {
  /** null: a month that only has owner stays */
  id: number | null;
  property_id: number;
  property: string;
  month: string;
  nights_available: number | null;
  nights_booked: number;
  owner_nights: number;
  check_ins: number;
  notes: string;
  owner_nights_source: "stays" | "manual";
  manual_owner_nights: number | null;
}

type Draft = { nights_available: string; nights_booked: string; owner_nights: string; check_ins: string };

export default function Occupancy() {
  const { canWrite } = useSession();
  const linked = Number(useSearchParams()[0].get("year"));
  const [year, setYear] = usePersistentState("occ-year", THIS_YEAR, linked > 1900 ? linked : undefined);
  const propertyId = useProperty().single;
  const { data, reload } = useApi<Row[]>(`occupancy?year=${year}&property_id=${propertyId}`);
  const stays = useApi<OwnerStay[]>(`owner-stays?year=${year}&property_id=${propertyId}`);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // confirmations from the booking calendar live on the To do page
  const todo = useApi<{ occupancy: number }>(`todo?property_id=${propertyId}`);
  // months whose saved numbers were kept over the calendar's ("Keep mine" on To do)
  const vsCalendar = useApi<{ months: MonthCompare[] }>(`occupancy/calendar?year=${year}&property_id=${propertyId}`);
  const [openKept, setOpenKept] = useState<string | null>(null);
  const scoped = useScopedPath();
  const toast = useToast();
  const reloadAll = () => {
    void reload();
    void stays.reload();
    void todo.reload();
    void vsCalendar.reload();
    window.dispatchEvent(new Event("todo:changed"));
  };

  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const rowFor = (m: string) => data?.find((r) => r.month === m);
  const keptFor = (m: string) => vsCalendar.data?.months.find((c) => c.month === m && c.kept);
  const askAgain = async (c: MonthCompare) => {
    try {
      await api(`occupancy/calendar/keep/${c.kept!.id}`, { method: "DELETE" });
      setOpenKept(null);
      toast({ text: `${monthLabel(c.month, "long")} is back on To do`, kind: "ok" });
      reloadAll();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };
  const lockedOwner = (m: string) => rowFor(m)?.owner_nights_source === "stays";
  const valueOf = (m: string, k: keyof Draft) =>
    k === "owner_nights" && lockedOwner(m)
      ? String(rowFor(m)!.owner_nights)
      : (drafts[m]?.[k] ?? String(rowFor(m)?.[k] ?? ""));
  const edit = (m: string, k: keyof Draft, v: string) =>
    setDrafts((d) => ({
      ...d,
      [m]: {
        nights_available: valueOf(m, "nights_available"),
        nights_booked: valueOf(m, "nights_booked"),
        owner_nights: valueOf(m, "owner_nights"),
        check_ins: valueOf(m, "check_ins"),
        ...d[m],
        [k]: v,
      },
    }));

  const save = async () => {
    const rows = Object.entries(drafts).map(([month, d]) => ({
      property_id: propertyId,
      month,
      nights_available: d.nights_available === "" ? null : Number(d.nights_available),
      nights_booked: Number(d.nights_booked || 0),
      owner_nights: Number(d.owner_nights || 0),
      check_ins: Number(d.check_ins || 0),
    }));
    try {
      await api("occupancy", { method: "PUT", json: rows });
      setDrafts({});
      toast({ text: `Saved ${rows.length} month(s)`, kind: "ok" });
      reloadAll();
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    }
  };

  const tot = (data ?? []).reduce(
    (a, r) => ({
      booked: a.booked + r.nights_booked,
      owner: a.owner + r.owner_nights,
      avail: a.avail + (r.nights_available ?? 0),
      checkins: a.checkins + r.check_ins,
    }),
    { booked: 0, owner: 0, avail: 0, checkins: 0 },
  );
  const rentalPct = tot.booked + tot.owner ? tot.booked / (tot.booked + tot.owner) : null;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Occupancy</h1>
        <div className="head-actions">
          <YearSelect value={year} onChange={setYear} />
        </div>
      </header>
      <p className="muted">
        Guest and personal nights set the rental-use % that splits whole-property costs at tax time.
      </p>
      {!!todo.data?.occupancy && (
        <Link className="link-alert alert warn" to={scoped("/todo")}>
          {todo.data.occupancy} {todo.data.occupancy === 1 ? "thing" : "things"} from your booking calendar to confirm
          in To do →
        </Link>
      )}
      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Rental nights</span>
          <span className="tile-value">{tot.booked}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Personal nights</span>
          <span className="tile-value">{tot.owner}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Rental use</span>
          <span className="tile-value">{percent(rentalPct)}</span>
          <span className="tile-sub">used for indirect expenses</span>
        </div>
      </div>
      <div className="card table-card">
        <table className="data-table occ-table">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Available</th>
              <th className="num">Booked</th>
              <th className="num">Personal</th>
              <th className="num">Check-ins</th>
              <th className="num">Occupancy</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => {
              const booked = Number(valueOf(m, "nights_booked") || 0);
              const avail = Number(valueOf(m, "nights_available") || 0) - Number(valueOf(m, "owner_nights") || 0);
              const kept = keptFor(m);
              return (
                <Fragment key={m}>
                  <tr className={drafts[m] ? "dirty" : ""}>
                    <td>
                      {monthLabel(m, "long")}
                      {kept && (
                        <button
                          type="button"
                          className="badge muted kept-badge"
                          aria-expanded={openKept === m}
                          title={kept.kept!.note || "You kept your numbers over the calendar's"}
                          onClick={() => setOpenKept((o) => (o === m ? null : m))}
                        >
                          Kept
                        </button>
                      )}
                    </td>
                    {(["nights_available", "nights_booked", "owner_nights", "check_ins"] as const).map((k) => (
                      <td key={k} className="num">
                        <input
                          className="cell-input"
                          inputMode="numeric"
                          disabled={!canWrite || (k === "owner_nights" && lockedOwner(m))}
                          title={k === "owner_nights" && lockedOwner(m) ? "From owner stays" : undefined}
                          value={valueOf(m, k)}
                          onChange={(e) => edit(m, k, e.target.value.replace(/\D/g, ""))}
                          aria-label={`${monthLabel(m, "long")} ${k.replace("_", " ")}`}
                        />
                      </td>
                    ))}
                    <td className="num">
                      {avail > 0 && valueOf(m, "nights_booked") !== "" ? percent(booked / avail, 0) : "—"}
                    </td>
                  </tr>
                  {kept && openKept === m && (
                    <tr className="kept-detail">
                      <td colSpan={6}>
                        <p>
                          {kept.kept!.note ? (
                            <strong>{kept.kept!.note}</strong>
                          ) : (
                            <span className="muted">No reason given.</span>
                          )}
                        </p>
                        <p className="muted small">
                          Kept on {fmtDate(kept.kept!.created_at.slice(0, 10))} over the calendar's{" "}
                          {plural(kept.calendar!.nights_booked, "night")},{" "}
                          {plural(kept.calendar!.check_ins, "check-in")}. If either number changes, it's asked about
                          again on To do.
                        </p>
                        {canWrite && (
                          <button className="btn small" onClick={() => void askAgain(kept)}>
                            Ask again
                          </button>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {months.some(lockedOwner) && (
          <p className="muted small occ-note">Greyed-out personal nights come from the owner stays below.</p>
        )}
      </div>
      <OwnerStaysPanel
        propertyId={propertyId}
        year={year}
        stays={stays.data}
        personalDays={tot.owner}
        rentalDays={tot.booked}
        onChange={reloadAll}
      />
      {canWrite && Object.keys(drafts).length > 0 && (
        <div className="sticky-actions">
          <button className="btn" onClick={() => setDrafts({})}>
            Discard
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save {Object.keys(drafts).length} month(s)
          </button>
        </div>
      )}
    </div>
  );
}
