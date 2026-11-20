import { and, asc, between, count, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { DB } from "../db.ts";
import { categories, occupancy as occupancyTable, ownerStays, properties, transactions } from "../db/schema.ts";
import { listOwnerStays, occupancyRows, type OccupancyRow } from "./owner-stays.ts";
import { compareOccupancyCalendar } from "./occupancy-calendar.ts";
import { needsReceipt } from "./receipts.ts";
import { getProperty, resolvePropertyId, SCHEDULE_E_LINES } from "./ledger.ts";
import { getTaxYear } from "./rental.ts";
import { monthChecklist } from "./recurring.ts";
import { toCsv } from "./csv.ts";

const monthShort = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => Math.round(n * 10000) / 10000;

const t = transactions;
const c = categories;
const o = occupancyTable;
const isIncome = eq(c.kind, "income");
const isExpense = eq(c.kind, "expense");

/** sum(amount_cents) over rows matching `cond`, as a positive number when `negate` (expenses are stored negative). */
const sumWhen = (cond: SQL | undefined, negate = false) =>
  sql<number>`coalesce(${negate ? sql`-` : sql``}sum(CASE WHEN ${cond ?? sql`1`} THEN ${t.amountCents} END), 0)`.mapWith(
    Number,
  );

/** Live (not deleted) transactions in [from, to], optionally for one property. */
const liveBetween = (from: string, to: string, propertyId?: number) =>
  and(isNull(t.deletedAt), between(t.date, from, to), propertyId ? eq(t.propertyId, propertyId) : undefined);

export function availableYears(db: DB): number[] {
  const txYears = db
    .selectDistinct({ y: sql<number>`CAST(substr(${t.date}, 1, 4) AS INTEGER)`.mapWith(Number) })
    .from(t)
    .where(isNull(t.deletedAt))
    .all();
  const occYears = db
    .selectDistinct({ y: sql<number>`CAST(substr(${o.month}, 1, 4) AS INTEGER)`.mapWith(Number) })
    .from(o)
    .all();
  const stayYears = db
    .selectDistinct({ y: sql<number>`CAST(substr(${ownerStays.startDate}, 1, 4) AS INTEGER)`.mapWith(Number) })
    .from(ownerStays)
    .all();
  return [...new Set([...txYears, ...occYears, ...stayYears].map((r) => r.y))].sort((a, b) => b - a);
}

function totalsBetween(db: DB, from: string, to: string, propertyId?: number) {
  const r = db
    .select({
      income: sumWhen(isIncome),
      expense: sumWhen(isExpense, true),
      direct: sumWhen(and(isExpense, eq(t.allocation, "direct")), true),
      indirect: sumWhen(and(isExpense, eq(t.allocation, "indirect")), true),
      unallocated: sumWhen(and(isExpense, isNull(t.allocation)), true),
      count: count(),
    })
    .from(t)
    .innerJoin(c, eq(c.id, t.categoryId))
    .where(liveBetween(from, to, propertyId))
    .get()!;
  return {
    income: r.income / 100,
    expense: r.expense / 100,
    net: (r.income - r.expense) / 100,
    direct: r.direct / 100,
    indirect: r.indirect / 100,
    unallocated: r.unallocated / 100,
    count: r.count,
  };
}

/**
 * A year's occupancy totals. owner_nights come from owner stays where a month has any (occupancyRows), decided per
 * property and month. Months that only have stays add personal nights but not available nights, so they don't
 * change the occupancy rate's denominator.
 */
export function occupancyTotals(db: DB, year: number, propertyId?: number) {
  const rows = occupancyRows(db, { year, propertyId });
  const sum = (f: (r: OccupancyRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const recorded = rows.filter((r) => r.recorded);
  const r = {
    months: recorded.length,
    available: sum((r) => r.nights_available ?? 0),
    booked: sum((r) => r.nights_booked),
    owner: sum((r) => r.owner_nights),
    check_ins: sum((r) => r.check_ins),
  };
  const rentable = recorded.reduce((a, x) => a + (x.nights_available ?? 0) - x.owner_nights, 0);
  return {
    months_recorded: r.months,
    nights_available: r.available,
    nights_booked: r.booked,
    owner_nights: r.owner,
    check_ins: r.check_ins,
    occupancy_rate: rentable > 0 ? pct(r.booked / rentable) : null,
    avg_stay: r.check_ins > 0 ? r2(r.booked / r.check_ins) : null,
  };
}

/** Per-month occupancy added up over the given rows; nights_booked/available stay null without a saved row. */
function monthOccupancy(rows: OccupancyRow[]) {
  if (!rows.length) return null;
  const recorded = rows.filter((r) => r.recorded);
  return {
    booked: recorded.length ? recorded.reduce((a, r) => a + r.nights_booked, 0) : null,
    owner: rows.reduce((a, r) => a + r.owner_nights, 0),
    available: recorded.length ? recorded.reduce((a, r) => a + (r.nights_available ?? 0), 0) : null,
    check_ins: recorded.reduce((a, r) => a + r.check_ins, 0),
  };
}

/** Overview summary for a calendar year. */
export function summary(db: DB, year: number, propertyId?: number) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const live = liveBetween(from, to, propertyId);
  const totals = totalsBetween(db, from, to, propertyId);

  const monthExpr = sql<string>`substr(${t.date}, 1, 7)`;
  const monthlyRows = db
    .select({ month: monthExpr, income: sumWhen(isIncome), expense: sumWhen(isExpense, true) })
    .from(t)
    .innerJoin(c, eq(c.id, t.categoryId))
    .where(live)
    .groupBy(monthExpr)
    .all();
  const occRows = occupancyRows(db, { year, propertyId });
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, "0")}`;
    const m = monthlyRows.find((r) => r.month === month);
    const o = monthOccupancy(occRows.filter((r) => r.month === month));
    return {
      month,
      income: (m?.income ?? 0) / 100,
      expense: (m?.expense ?? 0) / 100,
      net: ((m?.income ?? 0) - (m?.expense ?? 0)) / 100,
      nights_booked: o?.booked ?? null,
      owner_nights: o?.owner ?? null,
      nights_available: o?.available ?? null,
    };
  });

  const byCategory = db
    .select({
      category_id: c.id,
      category: c.name,
      kind: c.kind,
      amount: sql<number>`abs(sum(${t.amountCents})) / 100.0`.mapWith(Number),
      count: count(),
      direct: sql<number>`${sumWhen(eq(t.allocation, "direct"), true)} / 100.0`.mapWith(Number),
      indirect: sql<number>`${sumWhen(eq(t.allocation, "indirect"), true)} / 100.0`.mapWith(Number),
    })
    .from(t)
    .innerJoin(c, eq(c.id, t.categoryId))
    .where(live)
    .groupBy(c.id)
    .orderBy(desc(sql`abs(sum(${t.amountCents}))`))
    .all();

  // Who gets paid: the vendor if set, else the subcategory (Acme PM, Electric…), else the category (Mortgage).
  const vendorTotal = sql<number>`-sum(${t.amountCents})`.mapWith(Number);
  const payee = sql<string>`CASE WHEN ${t.vendor} <> '' THEN ${t.vendor} WHEN ${t.subcategory} <> '' THEN ${t.subcategory} ELSE ${c.name} END`;
  const byVendor = db
    .select({ vendor: payee, amount: vendorTotal, count: count() })
    .from(t)
    .innerJoin(c, eq(c.id, t.categoryId))
    .where(and(live, isExpense))
    .groupBy(payee)
    .orderBy(desc(vendorTotal))
    .limit(10)
    .all()
    .map((r) => ({ ...r, amount: r.amount / 100 }));

  // Year-over-year: compare the same date range last year (YTD if this is the current year).
  const today = new Date().toISOString().slice(0, 10);
  const ytdEnd = today.startsWith(String(year)) ? today : to;
  const ytd = totalsBetween(db, from, ytdEnd, propertyId);
  const prevYtd = totalsBetween(db, `${year - 1}-01-01`, `${year - 1}${ytdEnd.slice(4)}`, propertyId);

  const occupancy = occupancyTotals(db, year, propertyId);
  const review = db
    .select({ n: count() })
    .from(t)
    .where(and(isNull(t.deletedAt), eq(t.needsReview, true), propertyId ? eq(t.propertyId, propertyId) : undefined))
    .get()!;

  return {
    year,
    property_id: propertyId ?? null,
    totals,
    comparison: { through: ytdEnd, current: ytd, previous: prevYtd },
    occupancy: {
      ...occupancy,
      revenue_per_booked_night: occupancy.nights_booked ? r2(totals.income / occupancy.nights_booked) : null,
    },
    monthly,
    by_category: byCategory,
    top_vendors: byVendor,
    needs_review: review.n,
    years: availableYears(db),
    /** All-properties view only: each property's share of the year (archived ones only if they have data). */
    by_property: propertyId ? null : propertyBreakdown(db, year),
  };
}

function propertyBreakdown(db: DB, year: number) {
  return db
    .select({ id: properties.id, name: properties.name, archived: properties.archived })
    .from(properties)
    .orderBy(properties.archived, properties.name)
    .all()
    .map((p) => {
      const totals = totalsBetween(db, `${year}-01-01`, `${year}-12-31`, p.id);
      const occ = occupancyTotals(db, year, p.id);
      return {
        property_id: p.id,
        property: p.name,
        archived: p.archived,
        ...totals,
        nights_booked: occ.nights_booked,
        occupancy_rate: occ.occupancy_rate,
      };
    })
    .filter((r) => !r.archived || r.count || r.nights_booked);
}

/** Totals for every year with data, newest first (income, expenses, net, nights booked). */
export function yearTotals(db: DB, propertyId?: number) {
  return availableYears(db).map((year) => ({
    year,
    ...totalsBetween(db, `${year}-01-01`, `${year}-12-31`, propertyId),
    nights_booked: occupancyTotals(db, year, propertyId).nights_booked,
  }));
}

// ======================= months & categories =======================

const shiftMonth = (ym: string, n: number) => {
  const i = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
};

/** One month in detail: totals vs last month / same month last year / 12-month average, per category, bills. */
export function monthDetail(db: DB, ym: string, propertyId?: number) {
  const range = (a: string, b: string) => [`${a}-01`, `${b}-31`] as const;
  const totals = totalsBetween(db, ...range(ym, ym), propertyId);
  const prevMonth = totalsBetween(db, ...range(shiftMonth(ym, -1), shiftMonth(ym, -1)), propertyId);
  const lastYear = totalsBetween(db, ...range(shiftMonth(ym, -12), shiftMonth(ym, -12)), propertyId);
  const trailing = totalsBetween(db, ...range(shiftMonth(ym, -12), shiftMonth(ym, -1)), propertyId);
  const avg = (n: number) => r2(n / 12);

  const monthExpr = sql<string>`substr(${t.date}, 1, 7)`;
  const perCat = db
    .select({
      category_id: c.id,
      month: monthExpr,
      amount: sql<number>`sum(${t.amountCents})`.mapWith(Number),
      count: count(),
    })
    .from(t)
    .innerJoin(c, eq(c.id, t.categoryId))
    .where(liveBetween(...range(shiftMonth(ym, -12), ym), propertyId))
    .groupBy(c.id, monthExpr)
    .all();
  const cats = db.select({ id: c.id, name: c.name, kind: c.kind, sort: c.sortOrder }).from(c).all();
  const by_category = cats
    .map((cat) => {
      const rows = perCat.filter((r) => r.category_id === cat.id);
      const cur = rows.find((r) => r.month === ym);
      const ly = rows.find((r) => r.month === shiftMonth(ym, -12));
      const prior = rows.filter((r) => r.month < ym).reduce((a, r) => a + r.amount, 0);
      return {
        category_id: cat.id,
        category: cat.name,
        kind: cat.kind,
        amount: (cur?.amount ?? 0) / 100,
        count: cur?.count ?? 0,
        last_year: (ly?.amount ?? 0) / 100,
        avg_12: r2(prior / 1200),
        sort: cat.sort,
      };
    })
    .filter((r) => r.count > 0 || r.avg_12 !== 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.sort - b.sort)
    .map(({ sort: _s, ...r }) => r);

  const occ = monthOccupancy(occupancyRows(db, { month: ym, propertyId }));

  return {
    month: ym,
    property_id: propertyId ?? null,
    totals,
    compare: {
      previous_month: { month: shiftMonth(ym, -1), ...prevMonth },
      same_month_last_year: { month: shiftMonth(ym, -12), ...lastYear },
      avg_12: {
        income: avg(trailing.income),
        expense: avg(trailing.expense),
        net: avg(trailing.net),
      },
    },
    occupancy: occ ? { nights_booked: occ.booked ?? 0, owner_nights: occ.owner, check_ins: occ.check_ins } : null,
    by_category,
    recurring: monthChecklist(db, ym, { propertyId }),
  };
}

/** Category × month grid for a year (with subcategory rows). Amounts are positive for both income and expenses. */
export function categoryMonths(db: DB, year: number, propertyId?: number) {
  const monthExpr = sql<string>`substr(${t.date}, 1, 7)`;
  const grouped = (y: number) =>
    db
      .select({
        category_id: c.id,
        category: c.name,
        kind: c.kind,
        sort: c.sortOrder,
        subcategory: t.subcategory,
        month: monthExpr,
        amount: sql<number>`sum(${t.amountCents})`.mapWith(Number),
        count: count(),
      })
      .from(t)
      .innerJoin(c, eq(c.id, t.categoryId))
      .where(liveBetween(`${y}-01-01`, `${y}-12-31`, propertyId))
      .groupBy(c.id, t.subcategory, monthExpr)
      .all();
  const rows = new Map<
    string,
    {
      category_id: number;
      category: string;
      kind: "income" | "expense";
      subcategory: string;
      sort: number;
      months: number[];
      counts: number[];
      total: number;
      prev_total: number;
    }
  >();
  const row = (r: ReturnType<typeof grouped>[number]) => {
    const k = `${r.category_id}|${r.subcategory}`;
    if (!rows.has(k))
      rows.set(k, {
        category_id: r.category_id,
        category: r.category,
        kind: r.kind,
        subcategory: r.subcategory,
        sort: r.sort,
        months: Array(12).fill(0),
        counts: Array(12).fill(0),
        total: 0,
        prev_total: 0,
      });
    return rows.get(k)!;
  };
  const sign = (kind: string) => (kind === "expense" ? -1 : 1);
  for (const r of grouped(year)) {
    const x = row(r);
    const i = Number(r.month.slice(5, 7)) - 1;
    x.months[i] = (sign(r.kind) * r.amount) / 100;
    x.counts[i] = r.count;
    x.total += (sign(r.kind) * r.amount) / 100;
  }
  for (const r of grouped(year - 1)) row(r).prev_total += (sign(r.kind) * r.amount) / 100;
  return {
    year,
    property_id: propertyId ?? null,
    rows: [...rows.values()]
      .map(({ sort: _s, ...r }) => ({ ...r, total: r2(r.total), prev_total: r2(r.prev_total) }))
      .sort(
        (a, b) =>
          (a.kind === b.kind ? 0 : a.kind === "income" ? -1 : 1) ||
          a.category.localeCompare(b.category) ||
          a.subcategory.localeCompare(b.subcategory),
      ),
  };
}

// ======================= tax report =======================

/** MACRS straight-line, mid-month convention, for residential (27.5y) or nonresidential (39y) real property. */
export function depreciationForYear(basis: number, placedInService: string, recoveryYears: number, year: number) {
  const [py, pm] = placedInService.split("-").map(Number) as [number, number];
  if (year < py) return { amount: 0, accumulated_before: 0 };
  const annual = basis / recoveryYears;
  const firstYearFraction = (12 - pm + 0.5) / 12;
  const yearAmount = (y: number) => {
    if (y < py) return 0;
    if (y === py) return annual * firstYearFraction;
    const elapsed = firstYearFraction + (y - py - 1); // full years before y, in years of depreciation
    const remaining = recoveryYears - elapsed;
    if (remaining <= 0) return 0;
    return annual * Math.min(1, remaining);
  };
  let accumulated = 0;
  for (let y = py; y < year; y++) accumulated += yearAmount(y);
  return { amount: r2(yearAmount(year)), accumulated_before: r2(accumulated) };
}

export function taxReport(db: DB, year: number, propertyRef?: number | string) {
  const propertyId = resolvePropertyId(db, propertyRef);
  const property = getProperty(db, propertyId);
  const inputs = getTaxYear(db, propertyId, year);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const live = liveBetween(from, to, propertyId);
  const grouped = (where: SQL | undefined, negate = false) =>
    db
      .select({
        category_id: c.id,
        category: c.name,
        schedule_e_line: c.scheduleELine,
        amount: sql<number>`${negate ? sql`-` : sql``}sum(${t.amountCents}) / 100.0`.mapWith(Number),
        count: count(),
      })
      .from(t)
      .innerJoin(c, eq(c.id, t.categoryId))
      .where(and(live, where))
      .groupBy(c.id)
      .orderBy(asc(c.sortOrder), asc(c.name))
      .all();

  const income = grouped(isIncome);
  const direct = grouped(and(isExpense, eq(t.allocation, "direct")), true);
  const indirect = grouped(and(isExpense, eq(t.allocation, "indirect")), true);
  const unallocated = grouped(and(isExpense, isNull(t.allocation)), true);
  const sum = (xs: { amount: number }[]) => r2(xs.reduce((a, x) => a + x.amount, 0));

  const payer = sql<string>`CASE WHEN ${t.vendor} = '' THEN '(unspecified)' ELSE ${t.vendor} END`;
  const payerTotal = sql<number>`sum(${t.amountCents})`.mapWith(Number);
  const incomeByPayer = db
    .select({ payer, amount: payerTotal, count: count() })
    .from(t)
    .innerJoin(c, eq(c.id, t.categoryId))
    .where(and(live, isIncome))
    .groupBy(payer)
    .orderBy(desc(payerTotal))
    .all()
    .map((r) => ({ ...r, amount: r.amount / 100 }));

  // ---- rental vs personal use (IRS Pub 527) ----
  const occ = occupancyTotals(db, year, propertyId);
  const ownerStaysInYear = listOwnerStays(db, { year, property_id: propertyId });
  const rentalDays = inputs.rental_days_override ?? occ.nights_booked;
  const personalDays = inputs.personal_days_override ?? occ.owner_nights;
  const usedDays = rentalDays + personalDays;
  const rentalPct = usedDays > 0 ? rentalDays / usedDays : 1;

  // ---- mortgage interest ----
  const mortgagePaid = sum(indirect.concat(direct).filter((l) => l.schedule_e_line === "12"));
  const useInterest = inputs.mortgage_interest != null;

  // ---- Schedule E lines ----
  const lines = new Map<
    string,
    { line: string; label: string; direct: number; indirect: number; indirect_allocated: number }
  >();
  const lineFor = (code: string | null) => {
    const key = code ?? "19";
    if (!lines.has(key))
      lines.set(key, {
        line: key,
        label: SCHEDULE_E_LINES[key] ?? "Other",
        direct: 0,
        indirect: 0,
        indirect_allocated: 0,
      });
    return lines.get(key)!;
  };
  for (const l of direct) {
    if (useInterest && l.schedule_e_line === "12") continue;
    lineFor(l.schedule_e_line).direct += l.amount;
  }
  for (const l of indirect) {
    if (useInterest && l.schedule_e_line === "12") continue;
    lineFor(l.schedule_e_line).indirect += l.amount;
  }
  if (useInterest) lineFor("12").indirect += inputs.mortgage_interest!;

  // depreciation
  let depreciation: null | {
    basis: number;
    placed_in_service: string;
    recovery_years: number;
    full_year: number;
    accumulated_before: number;
    allocated: number;
  } = null;
  if (property.building_basis && property.placed_in_service) {
    const d = depreciationForYear(property.building_basis, property.placed_in_service, property.recovery_years, year);
    depreciation = {
      basis: property.building_basis,
      placed_in_service: property.placed_in_service,
      recovery_years: property.recovery_years,
      full_year: d.amount,
      accumulated_before: d.accumulated_before,
      allocated: r2(d.amount * rentalPct),
    };
    if (d.amount) lineFor("18").indirect += d.amount;
  }

  const scheduleE = [...lines.values()]
    .map((l) => {
      const indirectAllocated = r2(l.indirect * rentalPct);
      return {
        ...l,
        direct: r2(l.direct),
        indirect: r2(l.indirect),
        indirect_allocated: indirectAllocated,
        total: r2(l.direct + indirectAllocated),
      };
    })
    .sort((a, b) => Number(a.line) - Number(b.line));

  const grossIncome = sum(income);
  const directTotal = sum(direct);
  const indirectTotal = sum(indirect);
  const totalDeductible = r2(scheduleE.reduce((a, l) => a + l.total, 0));

  // ---- checks ----
  const checks: { level: "error" | "warning" | "info"; code: string; message: string; ids?: number[] }[] = [];
  const idsWhere = (where: SQL | undefined) =>
    db
      .select({ id: t.id })
      .from(t)
      .innerJoin(c, eq(c.id, t.categoryId))
      .where(and(live, where))
      .orderBy(t.date)
      .all()
      .map((r) => r.id);
  const review = idsWhere(eq(t.needsReview, true));
  if (review.length)
    checks.push({
      level: "error",
      code: "needs_review",
      message: `${review.length} transaction(s) are flagged for review.`,
      ids: review,
    });
  const unalloc = idsWhere(and(isExpense, isNull(t.allocation)));
  if (unalloc.length)
    checks.push({
      level: "error",
      code: "unallocated",
      message: `${unalloc.length} expense(s) are not marked direct or indirect and are excluded from the totals below.`,
      ids: unalloc,
    });
  const noReceipt = idsWhere(needsReceipt());
  if (noReceipt.length)
    checks.push({
      level: "warning",
      code: "missing_receipts",
      message: `${noReceipt.length} expense(s) that should have a receipt have none attached (receipt rules are set per category in Settings → Categories).`,
      ids: noReceipt,
    });
  const missingMonths = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`).filter(
    (m) =>
      m <= new Date().toISOString().slice(0, 7) &&
      !db
        .select({ id: o.id })
        .from(o)
        .where(and(eq(o.propertyId, propertyId), eq(o.month, m)))
        .get(),
  );
  if (missingMonths.length && inputs.rental_days_override == null)
    checks.push({
      level: "warning",
      code: "missing_occupancy",
      message: `No occupancy data for ${missingMonths.join(", ")}. Rental/personal day counts may be incomplete.`,
    });
  if (mortgagePaid && !useInterest)
    checks.push({
      level: "warning",
      code: "mortgage_interest",
      message: `Mortgage payments of $${mortgagePaid.toLocaleString()} include principal (and possibly escrow), which is not deductible. Enter the Form 1098 interest for ${year} so the report uses interest only.`,
    });
  if (personalDays > Math.max(14, rentalDays * 0.1))
    checks.push({
      level: "warning",
      code: "personal_use",
      message: `Personal use (${personalDays} days) exceeds the greater of 14 days or 10% of rental days (${Math.max(14, Math.floor(rentalDays * 0.1))}). The property counts as a residence; deductions may be limited to rental income (IRC §280A, Pub 527 Worksheet 5-1).`,
    });
  if (rentalDays > 0 && rentalDays < 15)
    checks.push({
      level: "info",
      code: "under_15_days",
      message: "Rented fewer than 15 days: rental income may be excludable and expenses not deductible (IRC §280A(g)).",
    });
  // Before you file: the calendar's guest nights disagree with the saved ones (informational, not on the To do
  // list). Months where a connected calendar doesn't reach back are left out: their stays may just be missing.
  const vsCalendar = compareOccupancyCalendar(db, { property_id: propertyId, year });
  const differ = vsCalendar.months.filter((m) => m.status === "differs" && !m.incomplete.length);
  if (differ.length && inputs.rental_days_override == null) {
    const detail = differ.map(
      (m) => `${monthShort(m.month)} ${m.calendar!.nights_booked} vs ${m.stored?.nights_booked ?? "none"}`,
    );
    checks.push({
      level: "info",
      code: "calendar_nights_differ",
      message: `Before you file: the booking calendar's guest nights differ from the saved occupancy in ${differ.length} month(s) (calendar vs saved: ${detail.join(", ")}). Review them on the Occupancy page; direct bookings that aren't on the calendar are a good reason to keep yours.`,
    });
  }
  if (occ.avg_stay != null && occ.avg_stay <= 7)
    checks.push({
      level: "info",
      code: "short_term",
      message: `Average guest stay is ${occ.avg_stay} nights (7 or fewer). Under the passive activity rules this is generally not a "rental activity"; material participation may allow losses to offset other income, and substantial services could make it Schedule C. Confirm treatment with your preparer.`,
    });
  const bigFurnishing = idsWhere(
    and(isExpense, sql`${t.amountCents} <= -250000`, sql`${c.scheduleELine} IN ('15','19','14')`),
  );
  if (bigFurnishing.length)
    checks.push({
      level: "info",
      code: "capitalize",
      message: `${bigFurnishing.length} expense(s) are $2,500 or more. Items over the de minimis safe-harbor limit, and improvements (vs. repairs), may need to be depreciated instead of expensed.`,
      ids: bigFurnishing,
    });
  if (!depreciation)
    checks.push({
      level: "info",
      code: "no_depreciation",
      message: "Set the property's building basis and placed-in-service date to estimate depreciation (line 18).",
    });

  return {
    year,
    property: { id: property.id, name: property.name, address: property.address },
    inputs,
    income: { total: grossIncome, by_category: income, by_payer: incomeByPayer },
    expenses: {
      direct: { total: directTotal, by_category: direct },
      indirect: { total: indirectTotal, by_category: indirect },
      unallocated: { total: sum(unallocated), by_category: unallocated },
    },
    use: {
      rental_days: rentalDays,
      personal_days: personalDays,
      rental_pct: pct(rentalPct),
      source: inputs.rental_days_override != null || inputs.personal_days_override != null ? "override" : "occupancy",
      nights_available: occ.nights_available,
      check_ins: occ.check_ins,
      /** dated personal-use stays with nights in this year (first night → checkout day) */
      owner_stays: ownerStaysInYear.map((s) => ({
        start_date: s.start_date,
        end_date: s.end_date,
        nights_in_year: s.nights_in_year,
        kind: s.kind,
      })),
      avg_stay: occ.avg_stay,
    },
    allocation: {
      indirect_total: indirectTotal,
      indirect_deductible: r2(indirectTotal * rentalPct),
      indirect_personal: r2(indirectTotal * (1 - rentalPct)),
    },
    mortgage: { payments_recorded: mortgagePaid, interest_1098: inputs.mortgage_interest },
    depreciation,
    schedule_e: scheduleE,
    totals: {
      gross_income: grossIncome,
      direct_expenses: directTotal,
      indirect_expenses: indirectTotal,
      deductible_expenses: totalDeductible,
      net: r2(grossIncome - totalDeductible),
    },
    checks,
    disclaimer:
      "Estimates for organizing records. Allocation uses rental days ÷ (rental + personal days) per IRS Pub 527. Confirm figures and treatment with a tax professional.",
  };
}

/** The tax report as a flat CSV (section, item, amount, notes) for the preparer. */
export function taxReportCsv(r: ReturnType<typeof taxReport>) {
  const rows: Record<string, unknown>[] = [];
  const push = (section: string, item: string, amount: number | null, extra = "") =>
    rows.push({ section, item, amount, notes: extra });
  push("Summary", "Property", null, r.property.name);
  push("Summary", "Tax year", r.year);
  push("Summary", "Rental days", r.use.rental_days);
  push("Summary", "Personal days", r.use.personal_days);
  push("Summary", "Rental use %", Math.round(r.use.rental_pct * 10000) / 100);
  for (const l of r.income.by_category) push("Income", l.category, l.amount, `${l.count} transactions`);
  for (const l of r.income.by_payer) push("Income by payer", l.payer, l.amount, `${l.count} payouts`);
  for (const l of r.expenses.direct.by_category)
    push("Direct expenses", l.category, l.amount, `Sch E line ${l.schedule_e_line ?? "19"}`);
  push("Direct expenses", "Total", r.expenses.direct.total);
  for (const l of r.expenses.indirect.by_category)
    push("Indirect expenses", l.category, l.amount, `Sch E line ${l.schedule_e_line ?? "19"}`);
  push("Indirect expenses", "Total", r.expenses.indirect.total);
  push("Indirect expenses", "Deductible (× rental use %)", r.allocation.indirect_deductible);
  for (const l of r.expenses.unallocated.by_category) push("Unallocated expenses", l.category, l.amount);
  for (const l of r.schedule_e)
    push(
      "Schedule E",
      `Line ${l.line} ${l.label}`,
      l.total,
      `direct ${l.direct}; indirect ${l.indirect} → ${l.indirect_allocated}`,
    );
  push("Totals", "Gross income", r.totals.gross_income);
  push("Totals", "Deductible expenses", r.totals.deductible_expenses);
  push("Totals", "Net", r.totals.net);
  for (const ch of r.checks) push("Checks", ch.code, null, ch.message);
  return toCsv(rows, ["section", "item", "amount", "notes"]);
}
