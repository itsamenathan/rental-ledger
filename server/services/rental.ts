import { and, desc, eq, like } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db.ts";
import { occupancy, properties, taxYears } from "../db/schema.ts";
import { audit, cents, diff, dollars, requireWrite, type Actor } from "../context.ts";
import { resolvePropertyId } from "./ledger.ts";

// ======================= occupancy =======================

export const occupancyInput = z.object({
  property: z.union([z.number().int(), z.string()]).optional(),
  property_id: z.number().int().optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM"),
  nights_available: z.number().int().min(0).max(31).nullable().optional(),
  nights_booked: z.number().int().min(0).max(31).default(0).describe("Nights rented to guests at fair rental price"),
  owner_nights: z
    .number()
    .int()
    .min(0)
    .max(31)
    .default(0)
    .describe("Personal-use nights (owner, family, below-market)"),
  check_ins: z.number().int().min(0).default(0),
  notes: z.string().max(2000).default(""),
});

const occupancyCols = {
  id: occupancy.id,
  property_id: occupancy.propertyId,
  property: properties.name,
  month: occupancy.month,
  nights_available: occupancy.nightsAvailable,
  nights_booked: occupancy.nightsBooked,
  owner_nights: occupancy.ownerNights,
  check_ins: occupancy.checkIns,
  notes: occupancy.notes,
};

function selectOccupancy(db: DB) {
  return db.select(occupancyCols).from(occupancy).innerJoin(properties, eq(properties.id, occupancy.propertyId));
}

export function listOccupancy(db: DB, opts: { year?: number; property_id?: number }) {
  return selectOccupancy(db)
    .where(
      and(
        opts.year ? like(occupancy.month, `${opts.year}-%`) : undefined,
        opts.property_id ? eq(occupancy.propertyId, opts.property_id) : undefined,
      ),
    )
    .orderBy(desc(occupancy.month))
    .all();
}

function findOccupancy(db: DB, propertyId: number, month: string) {
  return selectOccupancy(db)
    .where(and(eq(occupancy.propertyId, propertyId), eq(occupancy.month, month)))
    .get();
}

export function upsertOccupancy(db: DB, actor: Actor | null, raw: unknown) {
  if (actor) requireWrite(actor);
  const o = occupancyInput.parse(raw);
  const propertyId = resolvePropertyId(db, o.property_id ?? o.property);
  const before = findOccupancy(db, propertyId, o.month);
  const values = {
    nightsAvailable: o.nights_available ?? daysInMonth(o.month),
    nightsBooked: o.nights_booked,
    ownerNights: o.owner_nights,
    checkIns: o.check_ins,
    notes: o.notes,
  };
  db.insert(occupancy)
    .values({ propertyId, month: o.month, ...values })
    .onConflictDoUpdate({ target: [occupancy.propertyId, occupancy.month], set: values })
    .run();
  const after = findOccupancy(db, propertyId, o.month)!;
  audit(db, actor, before ? "update" : "create", "occupancy", after.id, before ? diff(before, after) : after);
  return after;
}

export function deleteOccupancy(db: DB, actor: Actor, id: number) {
  requireWrite(actor);
  const before = selectOccupancy(db).where(eq(occupancy.id, id)).get();
  db.delete(occupancy).where(eq(occupancy.id, id)).run();
  audit(db, actor, "delete", "occupancy", id, before);
}

function daysInMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

// ======================= per-year tax inputs =======================

export const taxYearInput = z.object({
  property: z.union([z.number().int(), z.string()]).optional(),
  property_id: z.number().int().optional(),
  year: z.number().int().min(2000).max(2100),
  mortgage_interest: z.number().min(0).nullable().optional().describe("Mortgage interest from Form 1098"),
  rental_days_override: z.number().int().min(0).max(366).nullable().optional(),
  personal_days_override: z.number().int().min(0).max(366).nullable().optional(),
  notes: z.string().max(5000).optional(),
});

export interface TaxYear {
  property_id: number;
  year: number;
  mortgage_interest: number | null;
  rental_days_override: number | null;
  personal_days_override: number | null;
  notes: string;
}

export function getTaxYear(db: DB, propertyId: number, year: number): TaxYear {
  const r = db
    .select()
    .from(taxYears)
    .where(and(eq(taxYears.propertyId, propertyId), eq(taxYears.year, year)))
    .get();
  return {
    property_id: propertyId,
    year,
    mortgage_interest: dollars(r?.mortgageInterestCents),
    rental_days_override: r?.rentalDaysOverride ?? null,
    personal_days_override: r?.personalDaysOverride ?? null,
    notes: r?.notes ?? "",
  };
}

export function setTaxYear(db: DB, actor: Actor | null, raw: unknown) {
  if (actor) requireWrite(actor);
  const i = taxYearInput.parse(raw);
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  const before = getTaxYear(db, propertyId, i.year);
  const mortgage = i.mortgage_interest !== undefined ? i.mortgage_interest : before.mortgage_interest;
  const values = {
    mortgageInterestCents: mortgage == null ? null : cents(mortgage),
    rentalDaysOverride: i.rental_days_override !== undefined ? i.rental_days_override : before.rental_days_override,
    personalDaysOverride:
      i.personal_days_override !== undefined ? i.personal_days_override : before.personal_days_override,
    notes: i.notes ?? before.notes,
  };
  db.insert(taxYears)
    .values({ propertyId, year: i.year, ...values })
    .onConflictDoUpdate({ target: [taxYears.propertyId, taxYears.year], set: values })
    .run();
  const after = getTaxYear(db, propertyId, i.year);
  audit(db, actor, "update", "tax_year", propertyId * 10000 + i.year, diff(before as never, after as never));
  return after;
}
