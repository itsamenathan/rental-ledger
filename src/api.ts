export type Allocation = "direct" | "indirect" | null;

export interface User {
  id: number;
  email: string;
  name: string;
  role: "admin" | "member" | "viewer";
}

export interface Category {
  id: number;
  name: string;
  kind: "income" | "expense";
  default_allocation: Allocation;
  schedule_e_line: string | null;
  description: string;
  sort_order: number;
  archived: boolean;
  /** when an expense here should have a receipt (server/services/receipts.ts) */
  receipt_policy: "always" | "threshold" | "never";
  /** dollar threshold for 'threshold'; null = Overview.receipt_min */
  receipt_min: number | null;
}

/** A vendor/subcategory name that never needs a receipt. */
export interface ReceiptExclusion {
  id: number;
  name: string;
  note: string;
  matches: number;
}

export interface Property {
  id: number;
  name: string;
  address: string;
  placed_in_service: string | null;
  building_basis: number | null;
  recovery_years: number;
  notes: string;
  archived: boolean;
}

export interface Transaction {
  id: number;
  property_id: number;
  property: string;
  date: string;
  amount: number;
  category_id: number;
  category: string;
  kind: "income" | "expense";
  schedule_e_line: string | null;
  subcategory: string;
  vendor: string;
  allocation: Allocation;
  description: string;
  account: string;
  reference: string;
  needs_review: boolean;
  review_note: string;
  source: string;
  external_id: string | null;
  attachment_count: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface Attachment {
  id: number;
  transaction_id: number;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
}

export interface TxList {
  items: Transaction[];
  total: number;
  totals: { net: number; income: number; expense: number };
  limit: number;
  offset: number;
}

export interface Overview {
  properties: Property[];
  categories: Category[];
  years: number[];
  schedule_e_lines: Record<string, string>;
  /** default receipt threshold in dollars */
  receipt_min: number;
}

export class ApiError extends Error {
  status: number;
  /** The error body's `details` (e.g. the current entry on a 409 conflict). */
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(path.startsWith("/") ? path : `/api/${path}`, {
    credentials: "same-origin",
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const body = data as { error?: string; details?: unknown } | null;
    const msg = body?.error ?? `${res.status} ${res.statusText}`;
    if (res.status === 401 && !path.includes("/auth/")) window.dispatchEvent(new Event("auth:expired"));
    throw new ApiError(res.status, msg, body?.details);
  }
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export interface LibraryFile {
  key: string;
  filename: string;
  content_type: string;
  size: number;
  uploaded_at: string;
  month: string;
  date: string;
  url: string;
  manager: { id: number; kind: "statement" | "invoice"; month: string; reference: string; property: string } | null;
  links: {
    attachment_id: number;
    transaction_id: number;
    date: string;
    amount: number;
    category: string;
    kind: "income" | "expense";
    vendor: string;
    subcategory: string;
    description: string;
    property: string;
  }[];
  /** Other attachments/manager documents keeping this file; 0 = unlinking the last listed entry deletes it. */
  other_uses: number;
}

export interface FileLibrary {
  period: { month: string | null; year: number };
  files: LibraryFile[];
  totals: { files: number; bytes: number; receipts: number; manager: number };
  missing: Transaction[];
  missing_total: number;
  receipt_min: number;
}

// ---------------- reports ----------------

export interface Totals {
  income: number;
  expense: number;
  net: number;
  direct: number;
  indirect: number;
  unallocated: number;
  count: number;
}

export type ChecklistState = "paid" | "missing" | "upcoming" | "skipped";

export interface RecurringAlert {
  level: "warning" | "info";
  type: "missing" | "duplicate" | "amount_changed" | "unusual";
  series_key: string;
  label: string;
  month: string;
  message: string;
  expected_amount: number;
  ids?: number[];
}

export interface ChecklistItem {
  series_key: string;
  label: string;
  category_id: number;
  category: string;
  vendor: string;
  subcategory: string;
  kind: "income" | "expense";
  cadence_label: string;
  typical_amount: number;
  fixed_amount: boolean;
  allocation: Allocation;
  property_id: number;
  expected_date: string;
  state: ChecklistState;
  amount: number | null;
  ids: number[];
}

export interface MonthDetail {
  month: string;
  totals: Totals;
  compare: {
    previous_month: Totals & { month: string };
    same_month_last_year: Totals & { month: string };
    avg_12: { income: number; expense: number; net: number };
  };
  occupancy: { nights_booked: number; owner_nights: number; check_ins: number } | null;
  by_category: {
    category_id: number;
    category: string;
    kind: "income" | "expense";
    amount: number;
    count: number;
    last_year: number;
    avg_12: number;
  }[];
  recurring: { month: string; items: ChecklistItem[]; alerts: RecurringAlert[] };
}

export interface CategoryMonths {
  year: number;
  rows: {
    category_id: number;
    category: string;
    kind: "income" | "expense";
    subcategory: string;
    months: number[];
    counts: number[];
    total: number;
    prev_total: number;
  }[];
}

export interface RecurringSeries {
  key: string;
  label: string;
  property_id: number;
  category_id: number;
  category: string;
  kind: "income" | "expense";
  vendor: string;
  subcategory: string;
  allocation: Allocation;
  cadence: number;
  cadence_label: string;
  occurrences: number;
  first_date: string;
  last_date: string;
  last_amount: number;
  typical_amount: number;
  fixed_amount: boolean;
  expected_day: number;
  next_due: string;
  status: "ok" | "due" | "missing" | "stopped" | "ignored";
  missing_months: string[];
  expected_months: string[];
  history: { month: string; amount: number; count: number; ids: number[]; dates: string[] }[];
}

export interface Recurring {
  today: string;
  series: RecurringSeries[];
  alerts: RecurringAlert[];
  dismissals: { id: number; series_key: string; month: string; note: string; created_at: string }[];
}

/** /add link that pre-fills a missing recurring payment. */
export function addLinkFor(
  s: { category_id: number; vendor: string; subcategory: string; kind: "income" | "expense"; typical_amount: number },
  date: string,
  back?: string,
) {
  return `/add${qs({
    kind: s.kind,
    category_id: s.category_id,
    vendor: s.vendor,
    subcategory: s.subcategory,
    amount: Math.abs(s.typical_amount).toFixed(2),
    date,
    back,
  })}`;
}

export const dismissRecurring = (series_key: string, month: string | null, note = "") =>
  api("recurring/dismissals", { method: "POST", json: { series_key, month, note } });
