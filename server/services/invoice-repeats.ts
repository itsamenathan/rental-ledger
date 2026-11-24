/**
 * Cross-month repeat check for the property manager's invoice lines: something billed again on a later invoice (a
 * repair, a purchase) that was already billed on an earlier one.
 *
 * Compared at the detail level: each line's description is split on "; " into sub-items (the parser joins detail lines
 * that way). Line totals are bundles that change month to month, so an amount only counts where the sub-item carries
 * its own price ("Queen flat sheet $32"); a line with no detail is compared as item + amount. Anything seen on three or
 * more months' invoices (up to the month reviewed) is a recurring service and stays quiet, as do phrases the user
 * marked "this recurs" (invoice_repeat_dismissals, per property). Only earlier invoices are looked at, so a later
 * invoice never makes an older month's review change its mind about a repeat.
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { tx, type DB } from "../db.ts";
import { invoiceRepeatDismissals } from "../db/schema.ts";
import { audit, badRequest, notFound, requireWrite, type Actor } from "../context.ts";
import { resolvePropertyId } from "./ledger.ts";
import type { InvoiceLine } from "./manager-statement.ts";

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const ABBREV: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MONTH_ALT = `${MONTH_NAMES.join("|")}|${Object.keys(ABBREV).join("|")}`;
const MONTH_WORD = new RegExp(`\\b(?:${MONTH_ALT})\\b\\.?`, "g");
/** "scheduled in August", "from July": a pointer to an earlier month, not an item. */
const MONTH_REF = new RegExp(`\\b(?:in|from|since|for|during|of)\\s+(${MONTH_ALT})\\b`, "gi");
/** Words left over from a pointer like "Was scheduled in August"; a sub-item made only of these isn't compared. */
const FILLER = new Set(
  "was were is been scheduled rescheduled originally in from for since during of the last this month done completed carried over billed moved postponed and to".split(
    " ",
  ),
);
/** Reconciled against the statement elsewhere; never warned about here as well. */
const RECONCILED = /insurance waiver|commission/i;

const usd = (c: number) =>
  `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toCents = (n: number) => Math.round(n * 100);

/**
 * Lower case, without month names, years, dates, punctuation, extra spaces, or a leading count written "(2)" or
 * "2 x". A plain leading number ("2nd floor", "3 bulbs") is kept: it isn't reliably a count.
 */
export function normalizePhrase(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/^\(\d+\)\s*/, "")
    .replace(/^\d+\s*x\s+/, "")
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
    .replace(MONTH_WORD, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const monthNumber = (word: string) => {
  const w = word.toLowerCase();
  const i = MONTH_NAMES.indexOf(w);
  return i >= 0 ? i + 1 : (ABBREV[w] ?? 0);
};

/** The latest month named `m` before `reviewed` ("August" on a September invoice = this year; on February = last). */
function pastMonth(m: number, reviewed: string): string {
  const y = Number(reviewed.slice(0, 4));
  const cur = Number(reviewed.slice(5, 7));
  return `${m < cur ? y : y - 1}-${String(m).padStart(2, "0")}`;
}

const monthLabel = (month: string, reviewed: string) => {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1]!;
  const cap = name[0]!.toUpperCase() + name.slice(1);
  return month.slice(0, 4) === reviewed.slice(0, 4) ? cap : `${cap} ${month.slice(0, 4)}`;
};

interface Entry {
  phrase: string;
  /** cents, when the sub-item carries its own price or for a whole line; null otherwise */
  price: number | null;
  label: string;
  /** index of the line it came from */
  line: number;
}

interface LineInfo {
  item: string;
  phrase: string;
  amount: number;
  /** months the detail points back to ("Was scheduled in August") */
  hints: { month: number; text: string }[];
  /** compared as a whole line (no comparable detail) */
  whole: boolean;
}

/** What one invoice offers for comparison. */
export function invoiceEntries(lines: InvoiceLine[]): { entries: Entry[]; info: (LineInfo | null)[] } {
  const entries: Entry[] = [];
  const info: (LineInfo | null)[] = [];
  lines.forEach((l, n) => {
    if (RECONCILED.test(l.item)) {
      info.push(null);
      return;
    }
    const hints: LineInfo["hints"] = [];
    let compared = 0;
    for (const raw of l.description.split(/;\s*/)) {
      const sub = raw.trim();
      if (!sub) continue;
      for (const m of sub.matchAll(MONTH_REF)) hints.push({ month: monthNumber(m[1]!), text: sub });
      const priced = sub.match(/^(.*?)[\s:–-]*\$\s?([\d,]+(?:\.\d{1,2})?)\s*$/);
      const text = priced ? priced[1]! : sub;
      const phrase = normalizePhrase(text);
      if (!phrase || phrase.split(" ").every((w) => FILLER.has(w))) continue;
      compared++;
      entries.push({
        phrase,
        price: priced ? toCents(Number(priced[2]!.replace(/,/g, ""))) : null,
        label: sub,
        line: n,
      });
    }
    const phrase = normalizePhrase(l.item);
    const amount = toCents(l.amount);
    if (!compared && phrase) entries.push({ phrase, price: amount, label: `"${l.item}" (${usd(amount)})`, line: n });
    info.push({ item: l.item, phrase, amount, hints, whole: !compared });
  });
  return { entries, info };
}

export interface RepeatInvoice {
  month: string;
  number: string;
  issued: string | null;
  documentId: number | null;
  lines: InvoiceLine[];
}

export interface RepeatWarning {
  text: string;
  /** Normalized phrase; "This recurs" remembers it. */
  phrase: string;
}

const order = (a: RepeatInvoice) =>
  `${a.month}|${a.issued ?? ""}|${String(a.documentId ?? Number.MAX_SAFE_INTEGER).padStart(16, "0")}|${a.number}`;

/**
 * Repeats on the reviewed month's invoices (`current`) against the property's earlier saved invoices (`saved`; it may
 * include the current ones, recognized by document id or invoice number). Invoices in the same month are compared in
 * (issued, saved) order, so the later one is flagged. `dismissed` holds the property's "this recurs" phrases;
 * `suppressed` lists the ones that hid a warning here.
 */
export function findInvoiceRepeats(opts: {
  month: string;
  current: RepeatInvoice[];
  saved: RepeatInvoice[];
  dismissed: Set<string>;
}): { warnings: RepeatWarning[]; suppressed: string[] } {
  const { month, current } = opts;
  const isCurrent = (s: RepeatInvoice) =>
    current.some(
      (c) => (c.documentId != null && c.documentId === s.documentId) || (!!c.number && c.number === s.number),
    );
  const pool = [...current, ...opts.saved.filter((s) => s.month <= month && !isCurrent(s))].sort((a, b) =>
    order(a).localeCompare(order(b)),
  );
  const parsed = new Map(pool.map((inv) => [inv, invoiceEntries(inv.lines)]));

  // Recurring: on three or more months' invoices, up to the reviewed month (later ones never count).
  const months = new Map<string, Set<string>>();
  const seen = (phrase: string, m: string) => {
    if (!months.has(phrase)) months.set(phrase, new Set());
    months.get(phrase)!.add(m);
  };
  for (const inv of pool) {
    const p = parsed.get(inv)!;
    for (const e of p.entries) seen(e.phrase, inv.month);
    for (const i of p.info) if (i) seen(`item:${i.phrase}`, inv.month);
  }
  const recurring = (phrase: string) => (months.get(phrase)?.size ?? 0) >= 3;

  const warnings: RepeatWarning[] = [];
  const suppressed = new Set<string>();
  const emit = (phrase: string, text: string) => {
    if (opts.dismissed.has(phrase)) suppressed.add(phrase);
    else if (!warnings.some((w) => w.text === text)) warnings.push({ text, phrase });
  };
  /** "the August invoice (#1980)", "the July (#1950) and August (#1980) invoices" */
  const where = (invs: RepeatInvoice[]) => {
    const num = (b: RepeatInvoice) => (b.number ? ` (#${b.number})` : "");
    if (invs.length === 1) return `the ${monthLabel(invs[0]!.month, month)} invoice${num(invs[0]!)}`;
    const parts = invs.map((b) => `${monthLabel(b.month, month)}${num(b)}`);
    return `the ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)} invoices`;
  };

  for (const a of current) {
    const prefix = current.length > 1 && a.number ? `Invoice ${a.number}: ` : "";
    const earlier = pool.slice(
      0,
      pool.findIndex((x) => x === a),
    );
    const mine = parsed.get(a)!;
    const hinted = new Set<number>();

    // "Was scheduled in August": did August's invoice already bill this item?
    mine.info.forEach((i, n) => {
      if (!i || !i.phrase || recurring(`item:${i.phrase}`)) return;
      for (const h of i.hints) {
        const target = pastMonth(h.month, month);
        const hit = earlier.filter(
          (b) => b.month === target && parsed.get(b)!.info.some((bi) => bi && bi.phrase === i.phrase),
        );
        if (!hit.length) continue;
        const billed = parsed.get(hit[0]!)!.info.find((bi) => bi && bi.phrase === i.phrase)!;
        hinted.add(n);
        emit(
          i.phrase,
          `${prefix}"${i.item}" (${usd(i.amount)}) says "${h.text}"; ${where(hit)} already billed "${billed.item}" (${usd(billed.amount)})`,
        );
      }
    });

    const done = new Set<string>();
    for (const e of mine.entries) {
      const key = `${e.phrase}|${e.price ?? ""}`;
      if (done.has(key) || recurring(e.phrase) || hinted.has(e.line)) continue;
      done.add(key);
      const hits = earlier.filter((b) =>
        parsed.get(b)!.entries.some((f) => f.phrase === e.phrase && f.price === e.price),
      );
      if (hits.length) emit(e.phrase, `${prefix}${e.label} was also billed on ${where(hits)}`);
    }
  }
  return { warnings, suppressed: [...suppressed] };
}

// ======================= "This recurs" =======================

export interface RepeatDismissal {
  id: number;
  property_id: number;
  phrase: string;
  note: string;
  created_at: string;
}

const ref = z.union([z.number().int(), z.string()]);

export function listRepeatDismissals(db: DB, raw: { property?: number | string } = {}): RepeatDismissal[] {
  const propertyId = resolvePropertyId(db, raw.property);
  const d = invoiceRepeatDismissals;
  return db
    .select({ id: d.id, property_id: d.propertyId, phrase: d.phrase, note: d.note, created_at: d.createdAt })
    .from(d)
    .where(eq(d.propertyId, propertyId))
    .orderBy(asc(d.phrase))
    .all();
}

export function dismissedPhrases(db: DB, propertyId: number): Map<string, number> {
  return new Map(
    db
      .select({ id: invoiceRepeatDismissals.id, phrase: invoiceRepeatDismissals.phrase })
      .from(invoiceRepeatDismissals)
      .where(eq(invoiceRepeatDismissals.propertyId, propertyId))
      .all()
      .map((r) => [r.phrase, r.id]),
  );
}

export const repeatDismissInput = z.object({
  property: ref.optional(),
  property_id: z.number().int().optional(),
  phrase: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("The repeat warning's phrase (or the item text; it is normalized the same way)"),
  note: z.string().trim().max(500).default(""),
});

/** "This recurs": stop flagging this phrase as a repeat on this property's invoices. */
export function dismissRepeat(db: DB, actor: Actor, raw: unknown) {
  requireWrite(actor);
  const i = repeatDismissInput.parse(raw);
  const propertyId = resolvePropertyId(db, i.property_id ?? i.property);
  const phrase = normalizePhrase(i.phrase);
  if (!phrase) throw badRequest("Nothing left of that phrase to remember");
  return tx(db, () => {
    const row = db
      .insert(invoiceRepeatDismissals)
      .values({ propertyId, phrase, note: i.note, createdBy: actor.user.id })
      .onConflictDoNothing()
      .returning({ id: invoiceRepeatDismissals.id })
      .get();
    if (row)
      audit(db, actor, "create", "invoice_repeat_dismissal", row.id, { property_id: propertyId, phrase, note: i.note });
    const id =
      row?.id ??
      db
        .select({ id: invoiceRepeatDismissals.id })
        .from(invoiceRepeatDismissals)
        .where(and(eq(invoiceRepeatDismissals.propertyId, propertyId), eq(invoiceRepeatDismissals.phrase, phrase)))
        .get()!.id;
    return { id, property_id: propertyId, phrase };
  });
}

/** Flag the phrase again. */
export function undismissRepeat(db: DB, actor: Actor, id: number) {
  requireWrite(actor);
  return tx(db, () => {
    const before = db.select().from(invoiceRepeatDismissals).where(eq(invoiceRepeatDismissals.id, id)).get();
    if (!before) throw notFound("Remembered phrase");
    db.delete(invoiceRepeatDismissals).where(eq(invoiceRepeatDismissals.id, id)).run();
    audit(db, actor, "delete", "invoice_repeat_dismissal", id, {
      property_id: before.propertyId,
      phrase: before.phrase,
      note: before.note,
    });
    return { ok: true };
  });
}
