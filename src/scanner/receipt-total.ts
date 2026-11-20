/**
 * Pull the total (and the purchase date) out of a receipt's OCR text. Pure, so it's unit-tested
 * (`receipt-total.test.ts`); the scanner only ever offers the result as a suggestion in the entry form.
 */

export interface ReceiptGuess {
  /** Dollars (positive), or null when nothing looked like a total. */
  total: number | null;
  /** True when the total came from a labelled line (TOTAL, AMOUNT DUE, …), false for the "largest amount" fallback. */
  labelled: boolean;
  /** YYYY-MM-DD, or null. */
  date: string | null;
}

/** An amount with cents: 12.34, $1,234.56, 12,34, "12. 34" (OCR spacing). The last group must be exactly 2 digits. */
const MONEY = /(?<![\d.,])\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\s?[.,]\s?(\d{2})(?![\d])/g;

/** Words that are read as a total, best first. OCR mixes up O/0 and L/1/I, so those are matched loosely. */
const LABELS: [RegExp, number][] = [
  [/grand\s*t[o0]ta[l1i]/, 6],
  [/(amount|amt|balance|bal|t[o0]ta[l1i])\s*(due|paid|charged)/, 5],
  [/(invoice|order|sale|purchase)\s*t[o0]ta[l1i]/, 5],
  [/t[o0]ta[l1i]\s*(amount|amt)/, 5],
  [/t[o0]ta[l1i]/, 4],
  [/balance/, 2],
  [/\b(visa|master\s*card|mastercard|amex|american express|discover|debit|credit|card)\b/, 1],
];

/** Lines that carry an amount but are never the total. */
const NEVER =
  /sub\s*-?\s*t[o0]ta[l1i]|change|\bcash\b|tender|sav(ed|ings?)|discount|coupon|previous|prior|items?\b|qty|quantity|points|rewards?|refund/;
/** Tax and tip lines are skipped, unless they say the amount includes them ("TOTAL INCL. TAX"). */
const EXTRA = /\btax|\btip\b|gratuity/;
const INCLUDES = /(incl|including|with|w\/|after|plus)\.?\s*(tax|tip|gratuity)/;
const skip = (line: string) => NEVER.test(line) || (EXTRA.test(line) && !INCLUDES.test(line));

const toAmount = (whole: string, cents: string) => Number(`${whole.replace(/,/g, "")}.${cents}`);

function amountsIn(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(MONEY)) {
    const n = toAmount(m[1]!, m[2]!);
    if (n > 0 && n < 1_000_000) out.push(n);
  }
  return out;
}

const SUBTOTAL = /sub\s*-?\s*t[o0]ta[l1i]/;
const TAX = /\btax/;
const TIP = /\btip\b|gratuity/;

/** The two amounts print the same apart from one digit (45.90 vs 45.99). */
function oneDigitOff(a: number, b: number) {
  const x = a.toFixed(2);
  const y = b.toFixed(2);
  if (x.length !== y.length) return false;
  let differ = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) differ++;
  return differ === 1;
}

/**
 * The best guess at the receipt's total. Labelled lines are ranked (GRAND TOTAL > AMOUNT DUE > TOTAL > card line),
 * then cross-checked, since OCR misreads a digit now and then: a total equal to subtotal + tax (+ tip), or repeated
 * on another labelled line (TOTAL and VISA), wins over a lone reading.
 */
export function findTotal(text: string): { total: number; labelled: boolean } | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const candidates: { total: number; score: number }[] = [];
  let subtotal: number | null = null;
  let tax = 0;
  let tip = 0;
  for (const [i, raw] of lines.entries()) {
    const line = raw.toLowerCase();
    // The amount is usually on the same line; a split column puts it alone on the next one.
    let amounts = amountsIn(raw);
    const next = lines[i + 1];
    if (!amounts.length && next && !/[a-z]{3,}/i.test(next)) amounts = amountsIn(next);
    const amount = amounts.at(-1);
    if (amount !== undefined) {
      if (SUBTOTAL.test(line)) subtotal = amount;
      else if (TAX.test(line) && !INCLUDES.test(line)) tax += amount;
      else if (TIP.test(line) && !INCLUDES.test(line)) tip += amount;
    }
    if (skip(line)) continue;
    const score = LABELS.find(([re]) => re.test(line))?.[1];
    if (score && amount !== undefined) candidates.push({ total: amount, score });
  }
  if (candidates.length) {
    const same = (a: number, b: number) => Math.abs(a - b) < 0.005;
    const expected = subtotal === null ? null : subtotal + tax + tip;
    let best: { total: number; score: number } | null = null;
    for (const c of candidates) {
      let score = c.score;
      if (expected !== null && same(c.total, expected)) score += 3.5;
      score += candidates.filter((o) => o !== c && same(o.total, c.total)).length;
      // Later lines win ties: a total after a tip line, or "AMOUNT PAID" after "TOTAL".
      if (!best || score >= best.score) best = { total: c.total, score };
    }
    // Small print: the total and card lines can share the same misread digit while subtotal and tax read right.
    // A sum that differs from the reading in just one digit is the better answer.
    if (expected !== null && !same(best!.total, expected) && oneDigitOff(best!.total, expected))
      return { total: Math.round(expected * 100) / 100, labelled: true };
    return { total: best!.total, labelled: true };
  }

  // Nothing labelled: the largest amount on a line that isn't change, tax, etc. is usually the total.
  const all = lines.filter((l) => !skip(l.toLowerCase())).flatMap(amountsIn);
  return all.length ? { total: Math.max(...all), labelled: false } : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null; // Feb 30 and the like
  return date.toISOString().slice(0, 10);
}

/**
 * The first date on the receipt that falls in the past year (receipts also print return-by and expiry dates, which
 * are later). US order (month first) for numeric dates.
 */
export function findDate(text: string, today: string): string | null {
  const latest = today;
  const earliest = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  const candidates: { at: number; date: string | null }[] = [];
  for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g))
    candidates.push({ at: m.index, date: isoDate(+m[1]!, +m[2]!, +m[3]!) });
  for (const m of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g))
    candidates.push({ at: m.index, date: isoDate(+m[3]!, +m[1]!, +m[2]!) });
  for (const m of text.matchAll(/\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi)) {
    const month = MONTHS.indexOf(m[1]!.toLowerCase());
    if (month >= 0) candidates.push({ at: m.index, date: isoDate(+m[3]!, month + 1, +m[2]!) });
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})\b/gi)) {
    const month = MONTHS.indexOf(m[2]!.toLowerCase());
    if (month >= 0) candidates.push({ at: m.index, date: isoDate(+m[3]!, month + 1, +m[1]!) });
  }
  candidates.sort((a, b) => a.at - b.at);
  return candidates.find((c) => c.date && c.date >= earliest && c.date <= latest)?.date ?? null;
}

export function readReceipt(text: string, today: string): ReceiptGuess {
  const total = findTotal(text);
  return { total: total?.total ?? null, labelled: total?.labelled ?? false, date: findDate(text, today) };
}
