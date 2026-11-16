/**
 * Importing bank, card or other provider CSV exports with a user-chosen column mapping.
 *
 * Flow: `inspectCsv` sniffs the layout (delimiter, header row, column samples) and suggests a mapping (a saved
 * profile whose headers match, else guesses from header names); `previewImport` applies a mapping and checks every
 * row against the ledger; the rows the user keeps are written with `commitImport` (bulkCreate, so undo works).
 *
 * Duplicate check, one-to-one (each existing transaction can be claimed by one file row):
 *  - "duplicate": same external id, or same property + date + amount with an equal (or missing) bank description
 *  - "possible": same property + amount within ±window days (the bank may post a day or two later, or the row
 *    was entered by hand / imported from another provider with different wording)
 */
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { auditLog, categories, importProfiles, transactions as t } from "../db/schema.ts";
import { audit, badRequest, cents, notFound, requireWrite, type Actor } from "../context.ts";
import { parseCsv } from "./csv.ts";
import * as ledger from "./ledger.ts";

// ======================= mapping =======================

/** Where a CSV column can go. `reference` is the bank's description (used for de-duplication). */
export const IMPORT_FIELDS = [
  "date",
  "amount",
  "money_out",
  "money_in",
  "direction",
  "reference",
  "vendor",
  "category",
  "subcategory",
  "description",
  "external_id",
  "account",
  "property",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const importMapping = z.object({
  delimiter: z.enum([",", ";", "\t", "|"]).default(","),
  /** 0-based row index of the header (rows above it are skipped). Without a header, data starts at this row. */
  header_row: z.number().int().min(0).max(100).default(0),
  has_header: z.boolean().default(true),
  /** field -> column: the header text, or "#3" for the 3rd column */
  columns: z.partialRecord(z.enum(IMPORT_FIELDS), z.string().max(200)).default({}),
  date_format: z.enum(["YMD", "MDY", "DMY"]).default("MDY"),
  number_format: z.enum(["us", "eu"]).default("us"),
  /** signed: one amount column; split: money out + money in columns; direction: amount + a debit/credit column */
  amount_mode: z.enum(["signed", "split", "direction"]).default("signed"),
  /** Flip every sign (card exports often list charges as positive) */
  negate: z.boolean().default(false),
  /** Values of the direction column that mean money out (case-insensitive) */
  outflow_values: z.array(z.string().max(100)).max(50).default([]),
  /** Account name for every row when no account column is mapped */
  account: z.string().trim().max(100).default(""),
});
export type ImportMapping = z.infer<typeof importMapping>;

// ======================= parsing helpers =======================

const DELIMITERS = [",", ";", "\t", "|"] as const;

/** Pick the delimiter that splits the first lines into the most consistent number (>1) of columns. */
export function detectDelimiter(text: string): ImportMapping["delimiter"] {
  const head = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 30)
    .join("\n");
  let best: ImportMapping["delimiter"] = ",";
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const widths = parseCsv(head, d).map((r) => r.length);
    const mode = modeOf(widths);
    if (mode < 2) continue;
    const score = widths.filter((w) => w === mode).length * Math.log2(mode + 1);
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  return best;
}

function modeOf(xs: number[]) {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let mode = 0;
  let n = 0;
  for (const [x, c] of counts) if (c > n || (c === n && x > mode)) [mode, n] = [x, c];
  return mode;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function ymd(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Parse a date in common export shapes. `format` decides ambiguous numeric dates like 03/04/2026. */
export function parseImportDate(raw: string, format: ImportMapping["date_format"] = "MDY"): string | null {
  const s = raw.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return ymd(+m[1]!, +m[2]!, +m[3]!);
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return ymd(+m[1]!, +m[2]!, +m[3]!);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) {
    const [a, b, y] = [+m[1]!, +m[2]!, +m[3]!];
    if (format === "YMD") return null;
    return format === "DMY" ? ymd(y, b, a) : ymd(y, a, b);
  }
  const mon = (x: string) => MONTHS.indexOf(x.slice(0, 3).toLowerCase()) + 1;
  // 05-Jan-2026, 5 Jan 2026
  if ((m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})\.?[\s,-]+(\d{2,4})\b/)) && mon(m[2]!))
    return ymd(+m[3]!, mon(m[2]!), +m[1]!);
  // Jan 5, 2026
  if ((m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{2,4})\b/)) && mon(m[1]!))
    return ymd(+m[3]!, mon(m[1]!), +m[2]!);
  return null;
}

/** Guess the date format from a column's values (a first part over 12 means day-first). */
export function detectDateFormat(values: string[]): ImportMapping["date_format"] {
  let dmy = false;
  let mdy = false;
  let iso = 0;
  let total = 0;
  for (const v of values) {
    const s = v.trim();
    if (!s) continue;
    total++;
    if (/^\d{4}[-/.]?\d{1,2}[-/.]?\d{1,2}/.test(s)) iso++;
    const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
    if (m) {
      if (+m[1]! > 12) dmy = true;
      if (+m[2]! > 12) mdy = true;
    }
  }
  if (total && iso === total) return "YMD";
  return dmy && !mdy ? "DMY" : "MDY";
}

/**
 * Parse money as signed dollars. Handles $ / currency codes, thousands separators, (parentheses), trailing minus
 * and DR/CR suffixes. Returns null for an empty cell and NaN when it can't be read.
 */
export function parseImportAmount(raw: string, format: ImportMapping["number_format"] = "us"): number | null {
  let s = raw.trim();
  if (!s || /^[-–—]$/.test(s)) return null;
  if (!/\d/.test(s)) return NaN;
  let sign = 1;
  const suffix = s.match(/\s*\b(DR|CR)\.?$/i);
  if (suffix) {
    if (suffix[1]!.toUpperCase() === "DR") sign = -1;
    s = s.slice(0, suffix.index);
  }
  if (/^\(.*\)$/.test(s)) {
    sign = -sign;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^\d.,+-]/g, "");
  if (s.endsWith("-")) {
    sign = -sign;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    sign = -sign;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  s = format === "eu" ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return s === "" ? null : NaN;
  return sign * Number(s);
}

function detectNumberFormat(values: string[]): ImportMapping["number_format"] {
  let eu = 0;
  let us = 0;
  for (const v of values) {
    if (/\d,\d{1,2}(\D*)$/.test(v.trim())) eu++;
    else if (/\d\.\d{1,2}(\D*)$/.test(v.trim())) us++;
  }
  return eu > us ? "eu" : "us";
}

const looksLikeData = (cell: string) =>
  parseImportDate(cell) != null || /^[-+($]*[\d.,]+\)?$/.test(cell.trim().replace(/\s/g, ""));

// ======================= reading a file =======================

interface Sheet {
  delimiter: ImportMapping["delimiter"];
  header_row: number;
  has_header: boolean;
  /** column keys ("header" or "#n") and display labels */
  columns: { key: string; label: string }[];
  rows: { line: number; cells: string[] }[];
  preamble: string[][];
}

/** Rows of the file as described by the layout part of a mapping. */
function readSheet(text: string, layout: Pick<ImportMapping, "delimiter" | "header_row" | "has_header">): Sheet {
  const all = parseCsv(text, layout.delimiter);
  if (!all.length) throw badRequest("The file is empty");
  const start = Math.min(layout.header_row, all.length - 1);
  const width = Math.max(...all.slice(start).map((r) => r.length));
  const headerCells = layout.has_header ? all[start]!.map((h) => h.trim()) : [];
  const seen = new Map<string, number>();
  const columns = Array.from({ length: width }, (_, i) => {
    const h = headerCells[i] ?? "";
    if (!h) return { key: `#${i + 1}`, label: layout.has_header ? `Column ${i + 1}` : `Column ${i + 1}` };
    // Repeated header names get "#n" keys so each column can still be mapped.
    const n = (seen.get(h.toLowerCase()) ?? 0) + 1;
    seen.set(h.toLowerCase(), n);
    return n > 1 ? { key: `#${i + 1}`, label: `${h} (${n})` } : { key: h, label: h };
  });
  const body = all.slice(layout.has_header ? start + 1 : start);
  const firstLine = (layout.has_header ? start + 1 : start) + 1;
  return {
    delimiter: layout.delimiter,
    header_row: start,
    has_header: layout.has_header,
    columns,
    rows: body.map((cells, i) => ({ line: firstLine + i, cells })),
    preamble: all.slice(0, start),
  };
}

function columnIndex(sheet: Sheet, ref: string | undefined): number {
  if (!ref) return -1;
  const byKey = sheet.columns.findIndex((c) => c.key === ref);
  if (byKey >= 0) return byKey;
  const lower = ref.trim().toLowerCase();
  const byName = sheet.columns.findIndex((c) => c.key.toLowerCase() === lower);
  if (byName >= 0) return byName;
  const m = ref.match(/^#(\d+)$/);
  return m && +m[1]! <= sheet.columns.length ? +m[1]! - 1 : -1;
}

// ======================= guessing a mapping =======================

const HEADER_GUESSES: [ImportField, RegExp][] = [
  ["date", /^(transaction|trans\.?|txn|booking|value)?\s*date$|^date\b/i],
  ["date", /^(post(ed|ing)?)\s*date$/i],
  // Before money out/in, so "Credit Debit Indicator" or Chase's "Details" (DEBIT/CREDIT) isn't taken as an amount.
  // It is kept only when its values look like debit/credit (see guessMapping).
  ["direction", /indicator|^details$|^(transaction\s*)?type$|^dr\s*\/\s*cr$|^cr\s*\/\s*dr$|^debit\s*\/\s*credit$/i],
  ["money_out", /debit|withdraw|money\s*out|paid\s*out|outflow|spent|^charges?$/i],
  ["money_in", /credit(?!\s*card)|deposit|money\s*in|paid\s*in|inflow|received/i],
  ["amount", /^(transaction\s*)?(amount|amt|value|total)(\s*\(.*\))?$|^amount/i],
  ["reference", /description/i],
  ["reference", /^details?$|narrative|^transaction$|^particulars$/i],
  ["vendor", /payee|merchant|vendor|counterparty|^name$/i],
  ["category", /^category$/i],
  ["subcategory", /^sub\s*-?category$/i],
  ["description", /memo|note|comment/i],
  [
    "external_id",
    /(transaction|txn|trans)\s*(id|number|no\.?|#)$|^id$|^fitid$|confirmation|^ref(erence)?\s*(id|number|no\.?|#)?$/i,
  ],
  ["account", /^account(\s*name)?$/i],
  ["property", /^property$/i],
];

const OUTFLOW_WORDS = /^(debit|dr|d|withdrawal|withdraw|charge|purchase|sale|out|payment sent|fee|-)$/i;

function guessMapping(sheet: Sheet): ImportMapping {
  const columns: ImportMapping["columns"] = {};
  const used = new Set<number>();
  const directionValues = (i: number) => distinct(sheet.rows.map((r) => r.cells[i] ?? "").filter((v) => v.trim()));
  const looksLikeDirection = (i: number) => {
    const vals = directionValues(i);
    return vals.length > 0 && vals.length <= 6 && vals.some((v) => OUTFLOW_WORDS.test(v));
  };
  if (sheet.has_header) {
    for (const [field, re] of HEADER_GUESSES) {
      if (columns[field]) continue;
      const i = sheet.columns.findIndex(
        (c, i) => !used.has(i) && re.test(c.label) && (field !== "direction" || looksLikeDirection(i)),
      );
      if (i >= 0) {
        columns[field] = sheet.columns[i]!.key;
        used.add(i);
      }
    }
  } else {
    // No header: the first date-looking column is the date, the first money-looking one the amount,
    // the widest text column the description.
    const sample = sheet.rows.slice(0, 20).map((r) => r.cells);
    const all = (i: number, ok: (s: string) => boolean) =>
      sample.length > 0 && sample.every((r) => !(r[i] ?? "").trim() || ok(r[i]!));
    sheet.columns.forEach((c, i) => {
      if (!columns.date && all(i, (s) => parseImportDate(s) != null)) columns.date = c.key;
      else if (!columns.amount && all(i, (s) => Number.isFinite(parseImportAmount(s)))) columns.amount = c.key;
    });
    let widest = -1;
    let width = 0;
    sheet.columns.forEach((c, i) => {
      if (c.key === columns.date || c.key === columns.amount) return;
      const w = sample.reduce((n, r) => n + (r[i]?.length ?? 0), 0);
      if (w > width) [widest, width] = [i, w];
    });
    if (widest >= 0) columns.reference = sheet.columns[widest]!.key;
  }
  // A lone "Payee"/"Name" column is the description.
  if (!columns.reference && columns.vendor) {
    columns.reference = columns.vendor;
    delete columns.vendor;
  }

  const values = (field: ImportField) => {
    const i = columnIndex(sheet, columns[field]);
    return i < 0 ? [] : sheet.rows.map((r) => r.cells[i] ?? "").filter((v) => v.trim());
  };
  let amount_mode: ImportMapping["amount_mode"] = "signed";
  let outflow_values: string[] = [];
  if (columns.amount) {
    delete columns.money_out;
    delete columns.money_in;
    if (columns.direction) {
      amount_mode = "direction";
      outflow_values = directionValues(columnIndex(sheet, columns.direction)).filter((v) => OUTFLOW_WORDS.test(v));
    }
  } else {
    delete columns.direction;
    if (columns.money_out || columns.money_in) amount_mode = "split";
  }

  return importMapping.parse({
    delimiter: sheet.delimiter,
    header_row: sheet.header_row,
    has_header: sheet.has_header,
    columns,
    date_format: detectDateFormat(values("date")),
    number_format: detectNumberFormat([...values("amount"), ...values("money_out"), ...values("money_in")]),
    amount_mode,
    outflow_values,
  });
}

function distinct(xs: string[]) {
  const seen = new Map<string, string>();
  for (const x of xs) {
    const k = x.trim().toLowerCase();
    if (!seen.has(k)) seen.set(k, x.trim());
  }
  return [...seen.values()];
}

// ======================= profiles =======================

export const profileInput = z.object({
  name: z.string().trim().min(1).max(100),
  headers: z.array(z.string().max(200)).max(200).default([]),
  mapping: importMapping,
});

type ProfileRow = typeof importProfiles.$inferSelect;
const toProfile = (r: ProfileRow) => ({
  id: r.id,
  name: r.name,
  headers: JSON.parse(r.headers) as string[],
  mapping: importMapping.parse(JSON.parse(r.mapping)),
  updated_at: r.updatedAt,
});
export type ImportProfile = ReturnType<typeof toProfile>;

export function listProfiles(db: DB): ImportProfile[] {
  return db.select().from(importProfiles).orderBy(importProfiles.name).all().map(toProfile);
}

function getProfile(db: DB, id: number) {
  const r = db.select().from(importProfiles).where(eq(importProfiles.id, id)).get();
  if (!r) throw notFound("Import profile");
  return toProfile(r);
}

/** Create a profile, or replace the one with the same name (case-insensitive). */
export function saveProfile(db: DB, actor: Actor, raw: unknown): ImportProfile {
  requireWrite(actor);
  const p = profileInput.parse(raw);
  const values = { name: p.name, headers: JSON.stringify(p.headers), mapping: JSON.stringify(p.mapping) };
  return tx(db, () => {
    const existing = db
      .select({ id: importProfiles.id })
      .from(importProfiles)
      .where(eq(sql`lower(${importProfiles.name})`, p.name.toLowerCase()))
      .get();
    let id: number;
    if (existing) {
      id = existing.id;
      db.update(importProfiles)
        .set({ ...values, updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')` })
        .where(eq(importProfiles.id, id))
        .run();
      audit(db, actor, "update", "import_profile", id, p);
    } else {
      id = db.insert(importProfiles).values(values).returning({ id: importProfiles.id }).get().id;
      audit(db, actor, "create", "import_profile", id, p);
    }
    return getProfile(db, id);
  });
}

export function deleteProfile(db: DB, actor: Actor, id: number) {
  requireWrite(actor);
  const before = getProfile(db, id);
  db.delete(importProfiles).where(eq(importProfiles.id, id)).run();
  audit(db, actor, "delete", "import_profile", id, before);
  return { id, deleted: true };
}

const norm = (h: string) => h.trim().toLowerCase();

/** The saved profile whose header row matches this file's (all of the profile's headers present). */
function matchProfile(db: DB, headers: string[]): ImportProfile | null {
  if (!headers.length) return null;
  const have = new Set(headers.map(norm));
  let best: ImportProfile | null = null;
  let bestScore = 0;
  for (const p of listProfiles(db)) {
    if (!p.headers.length || !p.headers.every((h) => have.has(norm(h)))) continue;
    const score = p.headers.length / have.size;
    if (score > bestScore) [best, bestScore] = [p, score];
  }
  return best;
}

// ======================= inspect =======================

export const inspectInput = z.object({
  text: z.string().min(1, "The file is empty"),
  delimiter: z.enum([",", ";", "\t", "|"]).optional(),
  header_row: z.number().int().min(0).max(100).optional(),
  has_header: z.boolean().optional(),
  profile_id: z.number().int().optional(),
});

/** Find the header row: the first row as wide as the data that isn't itself data. */
function detectLayout(text: string, delimiter: ImportMapping["delimiter"]) {
  const rows = parseCsv(text, delimiter).slice(0, 60);
  const width = modeOf(rows.map((r) => r.length));
  const first = Math.max(
    0,
    rows.findIndex((r) => r.length >= width && r.filter((c) => c.trim()).length >= Math.min(2, width)),
  );
  const cells = rows[first] ?? [];
  const has_header = cells.filter((c) => c.trim() && looksLikeData(c)).length === 0;
  return { header_row: first, has_header };
}

/**
 * Look at a file before importing: its layout, a sample of each column, and a suggested mapping (from a saved
 * profile with the same headers when there is one).
 */
export function inspectCsv(db: DB, raw: unknown) {
  const input = inspectInput.parse(raw);
  const delimiter = input.delimiter ?? detectDelimiter(input.text);
  const detected = detectLayout(input.text, delimiter);
  const layout = {
    delimiter,
    header_row: input.header_row ?? detected.header_row,
    has_header: input.has_header ?? detected.has_header,
  };
  const sheet = readSheet(input.text, layout);
  const headers = sheet.has_header ? sheet.columns.map((c) => c.label) : [];
  const profile = input.profile_id != null ? getProfile(db, input.profile_id) : matchProfile(db, headers);
  const mapping = profile
    ? { ...profile.mapping, delimiter: layout.delimiter, header_row: layout.header_row, has_header: layout.has_header }
    : guessMapping(sheet);
  return {
    ...layout,
    row_count: sheet.rows.length,
    preamble: sheet.preamble,
    columns: sheet.columns.map((c, i) => {
      const vals = sheet.rows.map((r) => r.cells[i] ?? "");
      const uniq = distinct(vals.filter((v) => v.trim()));
      return {
        ...c,
        samples: vals.filter((v) => v.trim()).slice(0, 5),
        // Few distinct values: likely a type/direction column; offered as checkboxes for "money out".
        values: uniq.length <= 12 ? uniq : null,
      };
    }),
    headers,
    profile: profile ? { id: profile.id, name: profile.name } : null,
    mapping,
    profiles: listProfiles(db).map((p) => ({ id: p.id, name: p.name })),
  };
}

// ======================= preview =======================

export const previewInput = z.object({
  text: z.string().min(1, "The file is empty"),
  mapping: importMapping,
  property: z.union([z.number().int(), z.string()]).optional().describe("Default property (name or id)"),
  window_days: z.number().int().min(0).max(14).default(3).describe("Possible-match window, ± days"),
});

export interface ExistingMatch {
  id: number;
  date: string;
  amount: number;
  category: string;
  vendor: string;
  reference: string;
  description: string;
  deleted: boolean;
  /** why it matched, e.g. "same transaction id", "same day", "2 days later" */
  reason: string;
}

export interface PreviewRow {
  line: number;
  status: "new" | "duplicate" | "possible" | "error";
  errors: string[];
  warnings: string[];
  date: string | null;
  amount: number | null;
  reference: string;
  vendor: string;
  description: string;
  category_id: number | null;
  /** category name, for callers (agents) that pass categories by name */
  category: string | null;
  category_source: "file" | "history" | "default" | null;
  subcategory: string;
  account: string;
  external_id: string | null;
  property_id: number | null;
  match: ExistingMatch | null;
}

const dayNumber = (d: string) => Date.parse(d + "T00:00:00Z") / 86_400_000;

/** Apply a mapping to a file and check each row against the ledger. Nothing is written. */
export function previewImport(db: DB, raw: unknown) {
  const input = previewInput.parse(raw);
  const map = input.mapping;
  const sheet = readSheet(input.text, map);
  const col = (f: ImportField) => columnIndex(sheet, map.columns[f]);
  const idx = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, col(f)])) as Record<ImportField, number>;
  for (const [f, ref] of Object.entries(map.columns))
    if (ref && idx[f as ImportField] < 0) throw badRequest(`Column "${ref}" (${f}) is not in this file`);
  if (idx.date < 0) throw badRequest("Choose the date column");
  if (map.amount_mode === "split" ? idx.money_out < 0 && idx.money_in < 0 : idx.amount < 0)
    throw badRequest(
      map.amount_mode === "split" ? "Choose the money out and/or money in columns" : "Choose the amount column",
    );
  if (map.amount_mode === "direction" && idx.direction < 0) throw badRequest("Choose the debit/credit column");

  let defaultProperty: number | null = null;
  let propertyError = "";
  try {
    defaultProperty = ledger.resolvePropertyId(db, input.property);
  } catch (e) {
    propertyError = (e as Error).message;
  }
  const cats = ledger.listCategories(db);
  const catByName = new Map<string, (typeof cats)[number]>();
  for (const c of [...cats].sort((a, b) => Number(b.archived) - Number(a.archived))) catByName.set(norm(c.name), c);
  const vendors = ledger
    .suggestions(db)
    .vendors.filter((v) => v.vendor.trim().length > 2)
    .sort((a, b) => b.vendor.length - a.vendor.length);
  const firstIncome = cats.find((c) => c.kind === "income" && !c.archived) ?? null;
  const outflow = new Set(map.outflow_values.map(norm));
  const propertyIds = new Map<string, number | null>();

  const rows: PreviewRow[] = sheet.rows.map(({ line, cells }) => {
    const cell = (f: ImportField) => (idx[f] >= 0 ? (cells[idx[f]] ?? "").trim() : "");
    const errors: string[] = [];
    const warnings: string[] = [];

    const rawDate = cell("date");
    const date = rawDate ? parseImportDate(rawDate, map.date_format) : null;
    if (!rawDate) errors.push("No date");
    else if (!date) errors.push(`Can't read the date "${rawDate}"`);

    let amount: number | null = null;
    const num = (f: ImportField) => parseImportAmount(cell(f), map.number_format);
    if (map.amount_mode === "split") {
      const out = num("money_out");
      const inn = num("money_in");
      if (Number.isNaN(out) || Number.isNaN(inn)) errors.push("Can't read the amount");
      else if (out != null || inn != null) amount = Math.abs(inn ?? 0) - Math.abs(out ?? 0);
    } else {
      const a = num("amount");
      if (Number.isNaN(a)) errors.push(`Can't read the amount "${cell("amount")}"`);
      else if (a != null)
        amount = map.amount_mode === "direction" ? (outflow.has(norm(cell("direction"))) ? -1 : 1) * Math.abs(a) : a;
    }
    if (amount != null && map.negate) amount = -amount;
    if (amount != null) amount = cents(amount) / 100;
    if (amount == null && !errors.length) errors.push("No amount");
    else if (amount === 0) errors.push("Amount is zero");

    const reference = cell("reference");
    let vendor = cell("vendor");
    let subcategory = cell("subcategory");
    let category_id: number | null = null;
    let category_source: PreviewRow["category_source"] = null;
    const fileCat = cell("category");
    if (fileCat) {
      const c = catByName.get(norm(fileCat));
      if (c) [category_id, category_source] = [c.id, "file"];
      else warnings.push(`No category named "${fileCat}"`);
    }
    if (category_id == null && amount) {
      const kind = amount > 0 ? "income" : "expense";
      const hay = `${vendor} ${reference}`.toLowerCase();
      const hit =
        vendors.find((v) => vendor && norm(v.vendor) === norm(vendor)) ??
        vendors.find((v) => hay.includes(v.vendor.toLowerCase()));
      const c = hit && catByName.get(norm(hit.category));
      if (hit && c && c.kind === kind) {
        [category_id, category_source] = [c.id, "history"];
        if (!vendor) vendor = hit.vendor;
        if (!subcategory) subcategory = hit.subcategory;
      } else if (kind === "income" && firstIncome) {
        [category_id, category_source] = [firstIncome.id, "default"];
        if (!vendor) vendor = /airbnb/i.test(hay) ? "Airbnb" : /vrbo|homeaway/i.test(hay) ? "VRBO" : "";
      }
    }

    let property_id = defaultProperty;
    const propName = cell("property");
    if (propName) {
      if (!propertyIds.has(norm(propName))) {
        try {
          propertyIds.set(norm(propName), ledger.resolvePropertyId(db, propName));
        } catch {
          propertyIds.set(norm(propName), null);
        }
      }
      property_id = propertyIds.get(norm(propName)) ?? null;
      if (property_id == null) errors.push(`No property named "${propName}"`);
    } else if (property_id == null) errors.push(propertyError || "Choose a property");

    const rawId = cell("external_id");
    const account = cell("account") || map.account;
    return {
      line,
      status: errors.length ? "error" : "new",
      errors,
      warnings,
      date,
      amount,
      reference,
      vendor,
      description: cell("description"),
      category_id,
      category: category_id == null ? null : (cats.find((c) => c.id === category_id)?.name ?? null),
      category_source,
      subcategory,
      account,
      external_id: rawId ? `csv:${account ? account + ":" : ""}${rawId}` : null,
      property_id,
      match: null,
    };
  });

  findMatches(db, rows, input.window_days);
  const count = (s: PreviewRow["status"]) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    summary: {
      total: rows.length,
      new: count("new"),
      duplicate: count("duplicate"),
      possible: count("possible"),
      error: count("error"),
      money_in: rows.reduce((n, r) => n + (r.status !== "error" && r.amount! > 0 ? r.amount! : 0), 0),
      money_out: rows.reduce((n, r) => n + (r.status !== "error" && r.amount! < 0 ? r.amount! : 0), 0),
      from: rows.reduce<string | null>((m, r) => (r.date && (!m || r.date < m) ? r.date : m), null),
      to: rows.reduce<string | null>((m, r) => (r.date && (!m || r.date > m) ? r.date : m), null),
    },
  };
}

/** Mark rows that are already in the ledger. Each existing transaction matches at most one row. */
function findMatches(db: DB, rows: PreviewRow[], windowDays: number) {
  const live = rows.filter((r) => r.status === "new");
  if (!live.length) return;
  const claimed = new Set<number>();
  const cols = {
    id: t.id,
    property_id: t.propertyId,
    date: t.date,
    amount_cents: t.amountCents,
    category: categories.name,
    vendor: t.vendor,
    reference: t.reference,
    description: t.description,
    external_id: t.externalId,
    deleted_at: t.deletedAt,
  };
  type Cand = {
    id: number;
    property_id: number;
    date: string;
    amount_cents: number;
    category: string;
    vendor: string;
    reference: string;
    description: string;
    external_id: string | null;
    deleted_at: string | null;
  };
  const toMatch = (c: Cand, reason: string): ExistingMatch => ({
    id: c.id,
    date: c.date,
    amount: c.amount_cents / 100,
    category: c.category,
    vendor: c.vendor,
    reference: c.reference,
    description: c.description,
    deleted: c.deleted_at != null,
    reason,
  });

  // 1. Same transaction id (also deleted rows: external_id is unique, so it can't be added again).
  const ids = live.flatMap((r) => (r.external_id ? [r.external_id] : []));
  if (ids.length) {
    const byId = new Map<string, Cand>();
    for (let i = 0; i < ids.length; i += 500)
      for (const c of db
        .select(cols)
        .from(t)
        .innerJoin(categories, eq(categories.id, t.categoryId))
        .where(inArray(t.externalId, ids.slice(i, i + 500)))
        .all())
        byId.set(c.external_id!, c);
    for (const r of live) {
      const c = r.external_id ? byId.get(r.external_id) : undefined;
      if (!c) continue;
      claimed.add(c.id);
      r.status = "duplicate";
      r.match = toMatch(c, c.deleted_at ? "same transaction id (a deleted transaction)" : "same transaction id");
    }
  }

  const dates = live.map((r) => r.date!).sort();
  const shift = (d: string, n: number) => new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);
  const props = [...new Set(live.map((r) => r.property_id!))];
  const cands = db
    .select(cols)
    .from(t)
    .innerJoin(categories, eq(categories.id, t.categoryId))
    .where(
      and(
        isNull(t.deletedAt),
        inArray(t.propertyId, props),
        gte(t.date, shift(dates[0]!, -windowDays)),
        lte(t.date, shift(dates.at(-1)!, windowDays)),
      ),
    )
    .all();
  const key = (p: number, cents: number) => `${p}:${cents}`;
  const byAmount = new Map<string, Cand[]>();
  for (const c of cands) {
    const k = key(c.property_id, c.amount_cents);
    byAmount.set(k, [...(byAmount.get(k) ?? []), c]);
  }
  const pending = () => live.filter((r) => r.status === "new");
  const sameRef = (a: string, b: string) => norm(a) === norm(b);

  // 2. Exact: same day and amount, same (or missing) description. Equal descriptions are claimed first.
  for (const strict of [true, false]) {
    for (const r of pending()) {
      const pool = byAmount.get(key(r.property_id!, cents(r.amount!))) ?? [];
      const c = pool.find(
        (c) =>
          !claimed.has(c.id) &&
          c.date === r.date &&
          (strict ? sameRef(c.reference, r.reference) : !c.reference || !r.reference),
      );
      if (!c) continue;
      claimed.add(c.id);
      r.status = "duplicate";
      r.match = toMatch(c, "same day and amount");
    }
  }

  // 3. Possible: same amount within the window (closest date wins).
  for (const r of pending()) {
    const pool = byAmount.get(key(r.property_id!, cents(r.amount!))) ?? [];
    let best: Cand | null = null;
    let bestGap = Infinity;
    for (const c of pool) {
      if (claimed.has(c.id)) continue;
      const gap = Math.abs(dayNumber(c.date) - dayNumber(r.date!));
      if (gap <= windowDays && gap < bestGap) [best, bestGap] = [c, gap];
    }
    if (!best) continue;
    claimed.add(best.id);
    const diff = dayNumber(best.date) - dayNumber(r.date!);
    r.status = "possible";
    r.match = toMatch(
      best,
      diff === 0
        ? "same day and amount, different description"
        : `same amount, ${Math.abs(diff)} day${Math.abs(diff) === 1 ? "" : "s"} ${diff < 0 ? "earlier" : "later"}`,
    );
  }
}

// ======================= commit =======================

export const commitInput = z.object({
  transactions: z.array(z.unknown()).min(1).max(5000),
});

/**
 * Write the rows the user kept after previewing. The preview already decided what is a duplicate, so rows are not
 * skipped again here (re-included look-alikes are wanted); a repeated transaction id is still refused.
 */
export function commitImport(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const input = commitInput.parse(raw);
  const r = ledger.bulkCreate(db, actor, { transactions: input.transactions, skip_duplicates: false });
  // The audit entry for the whole import, so the page can offer "Undo import".
  const entry = r.created
    ? db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.action, "bulk_create"), eq(auditLog.entity, "transaction")))
        .orderBy(desc(auditLog.id))
        .get()
    : undefined;
  return { ...r, audit_id: entry?.id ?? null };
}
