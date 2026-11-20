import { useState } from "react";
import { api } from "../api.ts";
import { monthLabel, percent, THIS_YEAR } from "../format.ts";
import { useApi, usePersistentState, useSession, useToast, useProperty } from "../hooks.ts";
import { YearSelect } from "../lib.tsx";
import { GuestNightsPanel, OwnerStaysPanel, StaysToConfirm } from "../components/OwnerStays.tsx";
import type { OwnerStay } from "../owner-stays.ts";

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
  const [year, setYear] = usePersistentState("occ-year", THIS_YEAR);
  const propertyId = useProperty().single;
  const { data, reload } = useApi<Row[]>(`occupancy?year=${year}&property_id=${propertyId}`);
  const stays = useApi<OwnerStay[]>(`owner-stays?year=${year}&property_id=${propertyId}`);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [version, setVersion] = useState(0);
  const toast = useToast();
  const reloadAll = () => {
    void reload();
    void stays.reload();
    setVersion((v) => v + 1);
  };

  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const rowFor = (m: string) => data?.find((r) => r.month === m);
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
        Rental nights and personal-use nights set the rental-use percentage used to prorate indirect expenses at tax
        time. Copy these from your Airbnb/VRBO occupancy report each month, or check them against your booking calendars
        below. Personal nights come from your owner stays for any month that has one.
      </p>
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
        <div className="tile">
          <span className="tile-label">Average stay</span>
          <span className="tile-value">{tot.checkins ? (tot.booked / tot.checkins).toFixed(1) : "—"}</span>
          <span className="tile-sub">nights per check-in</span>
        </div>
      </div>
      <StaysToConfirm propertyId={propertyId} year={year} version={version} onChange={reloadAll} />
      <GuestNightsPanel propertyId={propertyId} year={year} version={version} onChange={reloadAll} />
      <div className="card table-card">
        <table className="data-table occ-table">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Available</th>
              <th className="num">Booked</th>
              <th className="num">Owner / personal</th>
              <th className="num">Check-ins</th>
              <th className="num">Occupancy</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => {
              const booked = Number(valueOf(m, "nights_booked") || 0);
              const avail = Number(valueOf(m, "nights_available") || 0) - Number(valueOf(m, "owner_nights") || 0);
              return (
                <tr key={m} className={drafts[m] ? "dirty" : ""}>
                  <td>{monthLabel(m, "long")}</td>
                  {(["nights_available", "nights_booked", "owner_nights", "check_ins"] as const).map((k) => (
                    <td key={k} className="num">
                      <input
                        className="cell-input"
                        inputMode="numeric"
                        disabled={!canWrite || (k === "owner_nights" && lockedOwner(m))}
                        title={
                          k === "owner_nights" && lockedOwner(m)
                            ? `From owner stays${rowFor(m)?.manual_owner_nights ? ` (you had typed ${rowFor(m)!.manual_owner_nights})` : ""}`
                            : undefined
                        }
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
              );
            })}
          </tbody>
        </table>
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
