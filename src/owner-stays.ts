/** Owner stays in the app: kinds, labels and saving one (shared by the Occupancy and Calendar pages). */
import { api } from "./api.ts";
import type { useToast } from "./hooks.ts";

export type StayKind = "owner" | "family" | "below_market";
export const STAY_KINDS: { value: StayKind; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "family", label: "Family" },
  { value: "below_market", label: "Below-market" },
];
export const kindLabel = (k: StayKind | null) => STAY_KINDS.find((x) => x.value === k)?.label ?? "";

export interface OwnerStay {
  id: number;
  start_date: string;
  end_date: string;
  nights: number;
  nights_in_year: number;
  kind: StayKind | null;
  note: string;
}

/** "Thu Mar 5" */
export const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "Thu Mar 5 – Sun Mar 8 (3 nights)" */
export const rangeLabel = (r: { start_date: string; end_date: string; nights: number }) =>
  `${dayLabel(r.start_date)} – ${dayLabel(r.end_date)} (${plural(r.nights, "night")})`;

/** Save a stay and show the server's warnings (overlapping guest nights) as toasts. */
export async function saveOwnerStay(
  toast: ReturnType<typeof useToast>,
  body: { property_id: number; start_date: string; end_date: string; kind?: StayKind | null; note?: string },
  /** offer Undo in the toast; called after the stay is deleted again */
  undone?: () => void,
) {
  const r = await api<{ stay: OwnerStay; warnings: string[] }>("owner-stays", { method: "POST", json: body });
  toast({
    text: `Owner stay saved: ${rangeLabel(r.stay)}`,
    kind: "ok",
    action: undone && {
      label: "Undo",
      run: () =>
        void api(`owner-stays/${r.stay.id}`, { method: "DELETE" }).then(undone, (e: Error) =>
          toast({ text: e.message, kind: "error" }),
        ),
    },
  });
  for (const w of r.warnings) toast({ text: w, kind: "error" });
  return r.stay;
}

/** A blocked calendar range that may be an owner stay (server/services/occupancy-calendar.ts). */
export interface StayCandidate {
  start_date: string;
  end_date: string;
  nights: number;
  nights_in_year: number;
  blocked_on: string[];
  covering: string[];
  signal: "strong" | "unclear" | "weak";
  reason: string;
}

/** One month of calendar vs saved guest nights. */
export interface MonthCompare {
  month: string;
  status: "not_ended" | "no_data" | "match" | "differs";
  calendar: { nights_booked: number; check_ins: number } | null;
  stored: { nights_booked: number; check_ins: number } | null;
  calendar_lower: boolean;
  incomplete: string[];
}
