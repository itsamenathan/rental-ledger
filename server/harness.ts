/**
 * Test harness: a throwaway data folder filled with fictional data and known logins, so agents working in a
 * git worktree can run the app and check their changes. Run it through `scripts/harness` (it picks the Node
 * version from .node-version):
 *
 *   scripts/harness setup   install dependencies, then reset
 *   scripts/harness reset   wipe ./data and seed it again (stop the dev server first)
 *   scripts/harness dev     start `vp dev` on this worktree's own port
 *   scripts/harness info    print logins, API key and URL (data/harness.json)
 *
 * Reset only ever deletes a data folder that the harness created (it holds harness.json) or one that doesn't
 * exist yet, so it can't wipe a real ledger.
 *
 * Everything is fictional (names, vendors, amounts) and generated with a fixed seed relative to today, so
 * recurring-bill detection, the To do list and the tax report all have something to show.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

const MARKER = "harness.json";
// Shorter than the app's 10-character minimum on purpose; that rule is checked where users set passwords, not at login.
const PASSWORD = "password";
const USERS = [
  { email: "admin@example.com", name: "Alex Admin", role: "admin" },
  { email: "member@example.com", name: "Morgan Member", role: "member" },
  { email: "viewer@example.com", name: "Val Viewer", role: "viewer" },
] as const;

/** A stable port per worktree, so several worktrees can run `vp dev` side by side. */
export function harnessPort(dir = process.cwd()): number {
  const h = createHash("sha256").update(realpathSync(dir)).digest().readUInt32BE(0);
  return 5200 + (h % 700);
}

function assertSafeToWipe() {
  if (process.env.DATABASE_PATH || process.env.UPLOADS_DIR) {
    throw new Error("Unset DATABASE_PATH and UPLOADS_DIR: the harness only manages the data folder itself.");
  }
  const dir = config.dataDir;
  if (!existsSync(dir) || readdirSync(dir).length === 0 || existsSync(join(dir, MARKER))) return;
  throw new Error(
    `${dir} has data that the harness didn't create (no ${MARKER}). Refusing to delete it.\n` +
      `Run the harness in a git worktree, or point DATA_DIR at an empty folder.`,
  );
}

// ---------- deterministic fake data ----------

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymOf = (y: number, m: number) => `${y}-${pad(m)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

interface Row {
  date: string;
  amount: number;
  category: string;
  subcategory?: string;
  vendor?: string;
  description?: string;
  account?: string;
  allocation?: "direct" | "indirect" | null;
  needs_review?: boolean;
  review_note?: string;
  receipt?: boolean;
  trash?: boolean;
}

/** Every month from January two years ago through today; the current month stops at today's date. */
export function generate(today: Date) {
  const rand = rng(20261116);
  const between = (lo: number, hi: number) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

  const ty = today.getUTCFullYear();
  const tm = today.getUTCMonth() + 1;
  const todayIso = today.toISOString().slice(0, 10);
  const rows: Row[] = [];
  const occupancy: { month: string; nights_booked: number; owner_nights: number; check_ins: number }[] = [];

  const months: [number, number][] = [];
  for (let y = ty - 2; y <= ty; y++) for (let m = 1; m <= 12; m++) if (y < ty || m <= tm) months.push([y, m]);
  const prev = months.at(-2)!; // last complete month
  const prev2 = months.at(-3)!;

  for (const [y, m] of months) {
    const last = daysIn(y, m);
    const at = (d: number) => `${y}-${pad(m)}-${pad(Math.min(d, last))}`;
    const add = (d: number, row: Omit<Row, "date">) => {
      const date = at(d);
      if (date <= todayIso) rows.push({ account: "Checking", ...row, date });
    };
    const isPrev = y === prev[0] && m === prev[1];
    const isPrev2 = y === prev2[0] && m === prev2[1];
    const summer = m >= 5 && m <= 9;
    const winter = m <= 2 || m === 12;

    // Stays: Airbnb and VRBO payouts, a cleaning per stay, and the manager's cut.
    const stays = Math.max(2, Math.round((summer ? 6 : winter ? 2 : 4) + (rand() - 0.5) * 2));
    let booked = 0;
    let income = 0;
    let day = 2;
    for (let i = 0; i < stays && day < last; i++) {
      const nights = 2 + Math.floor(rand() * 4);
      booked += Math.min(nights, last - day);
      const payout = Math.round(nights * between(summer ? 210 : 150, summer ? 290 : 210) * 100) / 100;
      income += payout;
      // The second stay each month is VRBO, so both platforms are steady monthly series.
      const vrbo = i === 1;
      add(day + 1, {
        amount: payout,
        category: "Rental Income",
        subcategory: vrbo ? "VRBO" : "Airbnb",
        vendor: vrbo ? "VRBO" : "Airbnb",
        description: `${nights}-night stay`,
      });
      add(day + nights, {
        amount: -between(110, 145),
        category: "Cleaning",
        vendor: "Sparkle Clean Co",
        description: "Turnover clean",
        receipt: y < ty,
      });
      day += nights + 1 + Math.floor(rand() * 3);
    }
    const ownerNights = m === 7 || m === 12 ? 3 + Math.floor(rand() * 3) : 0;
    const monthDone = y < ty || m < tm;
    if (monthDone)
      occupancy.push({ month: ymOf(y, m), nights_booked: booked, owner_nights: ownerNights, check_ins: stays });

    add(last, {
      amount: -Math.round(income * 0.2 * 100) / 100,
      category: "Management Fee",
      subcategory: "Seabreeze Stays",
      vendor: "Seabreeze Stays",
      description: "20% management fee",
    });

    // Fixed monthly bills.
    add(1, { amount: -1482.37, category: "Mortgage", vendor: "Example Home Loans", description: "Monthly payment" });
    if (!isPrev) {
      // Internet is missing last month, so it shows up as a missed recurring bill.
      add(5, { amount: -79.99, category: "Utilities", subcategory: "Internet", vendor: "Example Fiber" });
    }
    const streaming = isPrev ? -17.99 : -15.49; // price change last month
    add(9, { amount: streaming, category: "Services", subcategory: "Streaming", vendor: "StreamFlix" });

    // Variable utilities.
    const electric = -between(summer ? 160 : 90, summer ? 240 : 150);
    add(12, { amount: electric, category: "Utilities", subcategory: "Electric", vendor: "Springfield Power" });
    if (isPrev2) {
      // Charged twice: an exact duplicate.
      add(12, { amount: electric, category: "Utilities", subcategory: "Electric", vendor: "Springfield Power" });
    }
    add(18, {
      amount: -between(winter ? 90 : 25, winter ? 160 : 45),
      category: "Utilities",
      subcategory: "Gas",
      vendor: "Springfield Gas",
    });
    if (m % 3 === 1) {
      add(20, { amount: -between(60, 95), category: "Utilities", subcategory: "Water", vendor: "Springfield Water" });
      add(15, { amount: -95, category: "Services", subcategory: "Pest control", vendor: "BugAway Pest Control" });
    }
    if (m >= 4 && m <= 10)
      add(22, { amount: -120, category: "Services", subcategory: "Lawn", vendor: "GreenCut Lawn" });

    // Yearly and twice-yearly bills.
    if (m === 3) add(10, { amount: -1864, category: "Insurance", vendor: "Example Mutual", receipt: true });
    if (m === 4 || m === 10) {
      add(28, { amount: -2153.5, category: "Property Tax", vendor: "Springfield County Treasurer", receipt: true });
    }
    if (m === 2) add(14, { amount: -650, category: "Professional Fees", vendor: "Ledger & Co CPAs", receipt: true });
    if (m === 1)
      add(15, { amount: -1240, category: "Taxes", subcategory: "Lodging tax", vendor: "State Revenue Dept" });

    // Supplies and the occasional repair or purchase.
    for (let i = 0, n = 1 + Math.floor(rand() * 2); i < n; i++) {
      const amount = -between(18, 140);
      add(3 + Math.floor(rand() * 24), {
        amount,
        category: "Supplies",
        vendor: pick(["Big Box Hardware", "Warehouse Club", "Online Store"]),
        description: pick(["Paper goods", "Coffee and pantry", "Linens", "Cleaning supplies", "Light bulbs"]),
        receipt: amount <= -75 && rand() < 0.6,
      });
    }
    if (rand() < 0.35) {
      add(6 + Math.floor(rand() * 20), {
        amount: -between(140, 820),
        category: "Maintenance",
        vendor: pick(["Handy Helpers", "Coastal Plumbing", "Bright Spark Electric"]),
        description: pick(["Fix dripping faucet", "Replace disposal", "Repair deck boards", "HVAC service"]),
        receipt: rand() < 0.5,
      });
    }
    if (rand() < 0.1) {
      add(11, {
        amount: -between(300, 1400),
        category: "Furnishings",
        vendor: "Home Furnishings Outlet",
        description: pick(["Sofa", "Patio set", "Mattress", "Smart TV"]),
        receipt: true,
      });
    }
  }

  // To do items: a flagged entry, one with no direct/indirect set, and an entry in the trash.
  const [py, pm] = prev;
  rows.push(
    {
      date: `${py}-${pad(pm)}-16`,
      amount: -212.4,
      category: "Supplies",
      vendor: "Online Store",
      description: "Unknown charge",
      needs_review: true,
      review_note: "Not sure this is for the rental",
      account: "Amex",
    },
    {
      date: `${py}-${pad(pm)}-19`,
      amount: -48,
      category: "Travel",
      vendor: "Highway Tolls",
      description: "Trip to meet the plumber",
      allocation: null,
      account: "Amex",
    },
    {
      date: `${py}-${pad(pm)}-21`,
      amount: -33.1,
      category: "Supplies",
      vendor: "Big Box Hardware",
      description: "Entered by mistake",
      trash: true,
    },
  );

  return { rows: rows.sort((a, b) => a.date.localeCompare(b.date)), occupancy, years: [ty - 2, ty - 1, ty] };
}

// ---------- reset ----------

/** The dev server keeps the database open, so a reset underneath it would leave it serving the deleted file. */
async function assertServerStopped(port: number) {
  const up = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );
  if (up) throw new Error(`The dev server is running on port ${port}. Stop it, reset, then start it again.`);
}

async function reset() {
  assertSafeToWipe();
  await assertServerStopped(harnessPort());
  rmSync(config.dataDir, { recursive: true, force: true });
  mkdirSync(config.dataDir, { recursive: true });
  // Write the marker first, so a failed seed can still be reset.
  writeFileSync(join(config.dataDir, MARKER), "{}\n");

  const { getDb, tx, closeDb } = await import("./db.ts");
  const { seedDefaults } = await import("./seed.ts");
  const ledger = await import("./services/ledger.ts");
  const auth = await import("./services/auth.ts");
  const rental = await import("./services/rental.ts");
  const { addAttachment } = await import("./services/attachments.ts");
  const db = getDb();

  const property = ledger.createProperty(db, null, {
    name: "Harbor View Cottage",
    address: "12 Example Lane, Springfield",
    placed_in_service: "2021-05-01",
    building_basis: 310000,
  });
  seedDefaults(db);

  const users = [];
  for (const u of USERS) users.push(await auth.createUser(db, null, { ...u, password: PASSWORD }));
  const admin = { user: users[0]!, apiKeyId: null, canWrite: true, via: "cli" as const };
  const writeKey = auth.createApiKey(db, admin, { name: "harness (write)", scope: "write" });
  const readKey = auth.createApiKey(db, admin, { name: "harness (read)", scope: "read" });
  const session = auth.createSession(db, admin.user.id);

  const today = process.env.HARNESS_TODAY ? new Date(`${process.env.HARNESS_TODAY}T12:00:00Z`) : new Date();
  const data = generate(today);
  const receipts: { id: number; row: Row }[] = [];
  tx(db, () => {
    for (const r of data.rows) {
      const { receipt, trash, ...input } = r;
      const t = ledger.createTransaction(db, admin, { ...input, property_id: property.id });
      if (receipt) receipts.push({ id: t.id, row: r });
      if (trash) ledger.deleteTransaction(db, admin, t.id);
    }
    for (const o of data.occupancy) rental.upsertOccupancy(db, admin, { ...o, property_id: property.id });
    for (const year of data.years.slice(0, 2)) {
      rental.setTaxYear(db, admin, { property_id: property.id, year, mortgage_interest: 11240.55 - (year % 10) * 180 });
    }
  });
  for (const { id, row } of receipts) {
    const text = `RECEIPT\n${row.vendor}\n${row.date}\n${row.description ?? row.category}\nTotal: $${(-row.amount).toFixed(2)}\n`;
    await addAttachment(db, admin, id, {
      filename: `${row.vendor} ${row.date}.txt`,
      contentType: "text/plain",
      data: new TextEncoder().encode(text),
    });
  }

  // A small bank export for trying CSV import: two new rows and one that's already in the ledger.
  const existing = data.rows.find((r) => r.vendor === "Springfield Power")!;
  const csv = [
    "Date,Description,Amount",
    `${existing.date},SPRINGFIELD POWER AUTOPAY,${existing.amount.toFixed(2)}`,
    `${today.toISOString().slice(0, 10)},BIG BOX HARDWARE #123,-64.12`,
    `${today.toISOString().slice(0, 10)},AIRBNB PAYOUT,845.00`,
  ].join("\n");
  writeFileSync(join(config.dataDir, "sample-bank-export.csv"), csv + "\n");

  const port = harnessPort();
  const info = {
    url: `http://localhost:${port}`,
    port,
    password: PASSWORD,
    users: USERS.map((u) => ({ email: u.email, role: u.role })),
    api_keys: { write: writeKey.key, read: readKey.key },
    admin_session_cookie: `rental_session=${session.token}`,
    property: property.name,
    transactions: data.rows.length,
    receipts: receipts.length,
    sample_csv: join(config.dataDir, "sample-bank-export.csv"),
    seeded_for: today.toISOString().slice(0, 10),
  };
  writeFileSync(join(config.dataDir, MARKER), JSON.stringify(info, null, 2) + "\n");
  closeDb(db);
  return info;
}

function printInfo(info: Awaited<ReturnType<typeof reset>>) {
  console.log(
    [
      `Test harness ready in ${config.dataDir}`,
      `  URL        ${info.url}   (start it with: scripts/harness dev)`,
      `  Login      admin@example.com / member@example.com / viewer@example.com, password ${info.password}`,
      `  API key    ${info.api_keys.write}   (Authorization: Bearer …)`,
      `  Details    ${join(config.dataDir, MARKER)}`,
    ].join("\n"),
  );
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "reset") printInfo(await reset());
  else if (command === "port") console.log(harnessPort());
  else {
    console.error(`Unknown command ${command ?? ""}. Use: reset | port`);
    process.exitCode = 1;
  }
}
