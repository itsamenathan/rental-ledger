/**
 * Offline outbox: work saved while the server can't be reached waits in IndexedDB and is sent the next time the app
 * is open with a connection (start-up, coming back online, returning to the app, "Sync now").
 *
 * Kinds of work:
 * - create: a new entry (and its receipts). Carries a `client_id`, so a replay returns the row already saved.
 * - attach: receipts for an entry that already exists. Re-sending the same bytes to an entry is a no-op on the server.
 * - update: fields changed on an existing entry. Sent with the entry's `updated_at` from when it was edited, so a
 *   change made elsewhere in the meantime is reported as a conflict instead of being overwritten.
 * - delete: removing an existing entry, guarded the same way.
 */
import { api, ApiError, type PortfolioRef, type Transaction } from "./api.ts";
import { PORTFOLIO_SLUG } from "./portfolio.ts";

export interface OutboxFile {
  name: string;
  type: string;
  /** Bytes are copied in at save time: a picked File doesn't survive a reload, and Safari is unreliable with Blobs. */
  data: ArrayBuffer;
}

export type OutboxOp = "create" | "attach" | "update" | "delete";

export interface OutboxEntry {
  /** Also the entry's client_id on the server (create). */
  id: string;
  op: OutboxOp;
  user_id: number;
  /**
   * The id of the portfolio it was saved in, and replays into (an id, not the slug, which can change). Missing on
   * work saved before there were several portfolios: that belongs to the first one (`setOutboxPortfolios`).
   */
  portfolio_id?: number;
  created_at: string;
  /** create: body for POST /api/transactions. */
  payload: Record<string, unknown> | null;
  /** The entry on the server: known up front for attach/update/delete, set once a create has been sent. */
  tx_id: number | null;
  files: OutboxFile[];
  /** Short text for the list, e.g. "Supplies · −$42.50". */
  label: string;
  date: string;
  /** The server refused it (validation, unsupported file, conflict): kept until retried or discarded. */
  error: string | null;
  /** Server errors (5xx) in a row; after a few the entry is marked failed so it can't hold up the rest. */
  attempts?: number;
  /** update: only the fields changed offline. Cleared once sent (receipts may still be waiting). */
  patch?: Record<string, unknown> | null;
  /** update/delete: the entry as it was when edited; its updated_at guards against overwriting newer changes. */
  base?: Transaction;
  /** The server's copy when it had changed since `base` (409). */
  conflict?: Transaction;
}

/** Give up on a request after this long so a weak signal queues the work instead of spinning on "Saving…". */
export const SAVE_TIMEOUT_MS = 15_000;
/** Phone photos on a slow connection need longer. */
export const UPLOAD_TIMEOUT_MS = 90_000;
const MAX_SERVER_ERRORS = 5;

/** An AbortSignal that fires after `ms` (counts as "unreachable", so the work is queued). */
export const timeout = (ms: number): AbortSignal | undefined => AbortSignal.timeout?.(ms);

const DB_NAME = "rental-ledger";
const STORE = "outbox";
export const OUTBOX_EVENT = "outbox:changed";

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("Can't open offline storage"));
    };
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error ?? new Error("Offline storage failed"));
    t.onabort = () => reject(t.error ?? new Error("Offline storage failed"));
  });
}

const changed = () => window.dispatchEvent(new Event(OUTBOX_EVENT));

/** A stored field as text (payloads and patches are loosely typed). */
export const asText = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";

/** The login's portfolios: this page's id, and each one's current slug for replaying into it. Set by the app on start. */
const known: { current: number | null; legacy: number | null; slugs: Map<number, string> } = {
  current: null,
  legacy: null,
  slugs: new Map(),
};
export function setOutboxPortfolios(portfolios: PortfolioRef[]) {
  known.slugs = new Map(portfolios.map((p) => [p.id, p.slug]));
  known.current = portfolios.find((p) => p.slug === PORTFOLIO_SLUG)?.id ?? null;
  // Work saved before there were several portfolios: everything then was moved into the first one (migration 0017).
  known.legacy = known.slugs.has(1) ? 1 : portfolios.length === 1 ? portfolios[0]!.id : null;
}
const portfolioOf = (e: OutboxEntry) => e.portfolio_id ?? known.legacy;

export async function listOutbox(userId: number): Promise<OutboxEntry[]> {
  const all = await run("readonly", (s) => s.getAll() as IDBRequest<OutboxEntry[]>);
  return all
    .filter((e) => e.user_id === userId && known.current != null && portfolioOf(e) === known.current)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

const get = (id: string) => run("readonly", (s) => s.get(id) as IDBRequest<OutboxEntry | undefined>);
const put = (e: OutboxEntry) => run("readwrite", (s) => s.put(e));
const remove = (id: string) => run("readwrite", (s) => s.delete(id));

export async function discardOutbox(id: string) {
  await remove(id);
  changed();
}

export async function retryOutbox(id: string) {
  const e = await get(id);
  if (e) await put({ ...e, error: null, attempts: 0 });
  changed();
}

/** After a conflict: send my changes anyway, on top of the server's current copy (only my fields change). */
export async function keepTheirs(id: string) {
  const e = await get(id);
  if (!e) return;
  // Drop my field changes, but receipts added with them still go up.
  if (e.files.length) await put({ ...e, patch: null, conflict: undefined, error: null, attempts: 0 });
  else await remove(id);
  changed();
}

export async function keepMine(id: string) {
  const e = await get(id);
  if (e?.conflict) await put({ ...e, base: e.conflict, conflict: undefined, error: null, attempts: 0 });
  changed();
}

// Entries open in an edit form are skipped by sync, so a send can't race the edit.
const held = new Set<string>();
export const holdEntry = (id: string) => void held.add(id);
export const releaseEntry = (id: string) => void held.delete(id);

export const newClientId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export const toOutboxFiles = (files: File[]): Promise<OutboxFile[]> =>
  Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, data: await f.arrayBuffer() })));

async function add(e: Omit<OutboxEntry, "created_at" | "error">) {
  await put({ ...e, created_at: new Date().toISOString(), error: null });
  // Ask the browser not to evict this storage under pressure (best effort; Safari may still clear it).
  void navigator.storage?.persist?.().catch(() => {});
  changed();
}

/** Queue a new entry (and its receipts), or receipts for an entry that already exists (`txId`). */
export async function enqueue(opts: {
  id?: string;
  userId: number;
  payload?: Record<string, unknown>;
  txId?: number;
  files: File[];
  label: string;
  date: string;
}) {
  const id = opts.id ?? newClientId();
  await add({
    id,
    op: opts.payload ? "create" : "attach",
    user_id: opts.userId,
    portfolio_id: known.current ?? undefined,
    payload: opts.payload ? { ...opts.payload, client_id: id } : null,
    tx_id: opts.txId ?? null,
    files: await toOutboxFiles(opts.files),
    label: opts.label,
    date: opts.date,
  });
}

/** Change a new entry that hasn't been sent yet. Fails if it was sent meanwhile (hold it while editing). */
export async function editQueued(
  id: string,
  next: { payload: Record<string, unknown>; files: OutboxFile[]; label: string; date: string },
) {
  const e = await get(id);
  if (!e || e.op !== "create" || e.tx_id != null) throw new Error("This entry was already sent; edit it from the list");
  await put({ ...e, ...next, payload: { ...next.payload, client_id: e.id }, error: null, attempts: 0 });
  changed();
}

const pendingFor = async (userId: number, txId: number, op: OutboxOp) =>
  (await listOutbox(userId)).filter((e) => e.op === op && e.tx_id === txId);

/** Queue changed fields (and receipts) for an existing entry; merges with changes already waiting for it. */
export async function enqueueUpdate(opts: {
  userId: number;
  base: Transaction;
  patch: Record<string, unknown>;
  files: File[];
  label: string;
}) {
  const files = await toOutboxFiles(opts.files);
  const prior = (await pendingFor(opts.userId, opts.base.id, "update")).find((e) => !e.error && !held.has(e.id));
  if (prior) {
    await put({
      ...prior,
      patch: { ...prior.patch, ...opts.patch },
      files: [...prior.files, ...files],
      label: opts.label,
      date: asText(opts.patch.date) || prior.date,
    });
    changed();
    return;
  }
  await add({
    id: newClientId(),
    op: "update",
    user_id: opts.userId,
    portfolio_id: known.current ?? undefined,
    payload: null,
    tx_id: opts.base.id,
    patch: opts.patch,
    base: opts.base,
    files,
    label: opts.label,
    date: asText(opts.patch.date) || opts.base.date,
  });
}

/** Queue deleting an existing entry; changes and receipts still waiting for it are dropped. */
export async function enqueueDelete(opts: { userId: number; base: Transaction; label: string }) {
  for (const op of ["update", "attach"] as const)
    for (const e of await pendingFor(opts.userId, opts.base.id, op)) await remove(e.id);
  await add({
    id: newClientId(),
    op: "delete",
    user_id: opts.userId,
    portfolio_id: known.current ?? undefined,
    payload: null,
    tx_id: opts.base.id,
    base: opts.base,
    files: [],
    label: opts.label,
    date: opts.base.date,
  });
}

/** A failure that means "try again later" (no connection, server or proxy down) rather than "this was refused". */
export const isUnreachable = (err: unknown) =>
  !(err instanceof ApiError) || err.status >= 500 || err.status === 408 || err.status === 429;

export interface SyncResult {
  synced: number;
  failed: number;
  /** Stopped early because the server couldn't be reached at all. */
  offline: boolean;
}

/** Upload one receipt; several phone photos in one request could pass the server's body limit. */
async function uploadOne(txId: number, f: OutboxFile, portfolio: string | null) {
  const form = new FormData();
  form.append("file", new File([f.data], f.name, { type: f.type }));
  await api(`transactions/${txId}/attachments`, {
    method: "POST",
    body: form,
    signal: timeout(UPLOAD_TIMEOUT_MS),
    portfolio,
  });
}

/**
 * Attach receipts to an entry that already exists, or keep them on this device when the server can't be reached.
 * Other errors (unsupported file, too large) are thrown.
 */
export async function uploadOrQueue(
  userId: number,
  tx: { id: number; date: string; label: string },
  files: File[],
): Promise<"uploaded" | "queued"> {
  try {
    for (const f of files) {
      const form = new FormData();
      form.append("file", f);
      await api(`transactions/${tx.id}/attachments`, {
        method: "POST",
        body: form,
        signal: timeout(UPLOAD_TIMEOUT_MS),
      });
    }
    return "uploaded";
  } catch (err) {
    if (!isUnreachable(err)) throw err;
    // Files sent before the failure are skipped by the server on replay (same bytes, same entry).
    await enqueue({ userId, txId: tx.id, files, label: tx.label, date: tx.date });
    return "queued";
  }
}

/** Send one entry, saving progress after each step so an interrupted send resumes where it stopped. */
async function send(e: OutboxEntry) {
  const guard = e.base?.updated_at;
  // Only this page's portfolio is listed, so this is the page's slug unless it was renamed since the page loaded.
  const id = portfolioOf(e);
  const portfolio = (id != null && known.slugs.get(id)) || PORTFOLIO_SLUG;
  if (e.op === "delete") {
    try {
      await api(`transactions/${e.tx_id}${guard ? `?expected_updated_at=${encodeURIComponent(guard)}` : ""}`, {
        method: "DELETE",
        signal: timeout(SAVE_TIMEOUT_MS),
        portfolio,
      });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err; // already gone: done
    }
    return;
  }
  if (e.op === "create" && e.tx_id == null) {
    if (!e.payload) throw new ApiError(400, "Nothing to send");
    const saved = await api<Transaction>("transactions", {
      method: "POST",
      json: e.payload,
      signal: timeout(SAVE_TIMEOUT_MS),
      portfolio,
    });
    e = { ...e, tx_id: saved.id };
    await put(e);
  }
  if (e.op === "update" && e.patch && Object.keys(e.patch).length) {
    await api<Transaction>(`transactions/${e.tx_id}`, {
      method: "PATCH",
      json: { ...e.patch, expected_updated_at: guard },
      signal: timeout(SAVE_TIMEOUT_MS),
      portfolio,
    });
    e = { ...e, patch: null };
    await put(e);
  }
  while (e.files.length) {
    await uploadOne(e.tx_id!, e.files[0]!, portfolio);
    e = { ...e, files: e.files.slice(1) };
    await put(e);
  }
}

async function syncEntries(userId: number): Promise<SyncResult> {
  const out: SyncResult = { synced: 0, failed: 0, offline: false };
  for (const e of await listOutbox(userId)) {
    if (e.error || held.has(e.id)) continue;
    try {
      await send(e);
      await remove(e.id);
      out.synced++;
    } catch (err) {
      // send() saves progress itself; re-read so the error is recorded on the latest copy.
      const latest = (await get(e.id)) ?? e;
      const status = err instanceof ApiError ? err.status : 0;
      // No connection (or signed out): nothing else will get through either.
      if (status === 0 || status === 401) {
        out.offline = status === 0;
        break;
      }
      if (status === 409) {
        const current = (err as ApiError).details as { current?: Transaction } | undefined;
        await put({
          ...latest,
          conflict: current?.current,
          error: "Changed elsewhere since you edited it offline",
        });
        out.failed++;
        continue;
      }
      if (isUnreachable(err)) {
        // Server trouble: count it against this entry and move on, so one bad entry can't hold up the rest.
        const attempts = (latest.attempts ?? 0) + 1;
        const failed = attempts >= MAX_SERVER_ERRORS;
        await put({ ...latest, attempts, error: failed ? `Server error: ${(err as Error).message}` : null });
        if (failed) out.failed++;
        continue;
      }
      await put({ ...latest, error: (err as Error).message });
      out.failed++;
    } finally {
      changed();
    }
  }
  return out;
}

let running: Promise<SyncResult> | null = null;

/** Send everything waiting for this user. One sync at a time, across tabs too where Web Locks exist. */
export function syncOutbox(userId: number): Promise<SyncResult> {
  if (running) return running;
  const skipped: SyncResult = { synced: 0, failed: 0, offline: false };
  const go = () => syncEntries(userId);
  const locks = navigator.locks;
  running = (
    locks ? locks.request("rental-outbox-sync", { ifAvailable: true }, (lock) => (lock ? go() : skipped)) : go()
  ).finally(() => {
    running = null;
  });
  return running;
}
