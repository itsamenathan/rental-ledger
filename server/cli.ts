/**
 * Admin CLI. Run inside the container with:
 *   node server/cli.ts create-user --email you@example.com --password '...' [--role admin] [--name "You"]
 *   node server/cli.ts set-password --email you@example.com --password '...'
 *   node server/cli.ts make-server-admin --email you@example.com   (re-enables it too: the way back in)
 *   node server/cli.ts import-grist --doc <docId> [--property "My Rental"] [--dry-run]
 *   (create-user and import-grist work in the only portfolio; with several, add --portfolio <name or slug>)
 *       (reads GRIST_BASE_URL and GRIST_API_KEY from the environment; read-only)
 *   node server/cli.ts backup [--out backup.zip]     database snapshot + receipts
 *   node server/cli.ts restore backup.zip            replace all data (stop the app first, or use the web UI)
 */
import { parseArgs } from "node:util";
import { closeDb, getDb } from "./db.ts";
import { seedDefaults } from "./seed.ts";
import { portfolios } from "./db/schema.ts";
import { inPortfolio, onlyPortfolioId } from "./portfolio.ts";
import { createUser, findUserByEmail, setPassword } from "./services/auth.ts";
import { makeInstanceAdmin } from "./services/portfolios.ts";
import { importFromGrist } from "./grist-import.ts";
import { backupFilename, restoreBackup, writeBackup } from "./services/backup.ts";
import { readFileSync } from "node:fs";

const [command, ...rest] = process.argv.slice(2);
const parsed = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    email: { type: "string" },
    password: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
    doc: { type: "string" },
    property: { type: "string" },
    "dry-run": { type: "boolean" },
    out: { type: "string" },
    portfolio: { type: "string" },
  },
});

const { values, positionals } = parsed;
const db = getDb();

/** The portfolio named by --portfolio (name or slug), else the only one. */
function inChosenPortfolio<T>(fn: () => T): T {
  if (!values.portfolio) return inPortfolio(onlyPortfolioId(db), fn);
  const want = values.portfolio.toLowerCase();
  const p = db
    .select({ id: portfolios.id, name: portfolios.name, slug: portfolios.slug })
    .from(portfolios)
    .all()
    .find((x) => x.slug === values.portfolio || x.name.toLowerCase() === want);
  if (!p) throw new Error(`No portfolio named ${values.portfolio}`);
  return inPortfolio(p.id, fn);
}

switch (command) {
  case "create-user": {
    if (!values.email) throw new Error("--email is required");
    const user = await inChosenPortfolio(() => {
      seedDefaults(db);
      return createUser(db, null, {
        email: values.email!,
        name: values.name ?? "",
        password: values.password,
        role: (values.role as "admin" | "member" | "viewer") ?? "admin",
      });
    });
    console.log("Created", user);
    break;
  }
  case "set-password": {
    const user = values.email && findUserByEmail(db, values.email);
    if (!user || !values.password) throw new Error("--email (existing user) and --password are required");
    await setPassword(db, user.id, values.password);
    console.log("Password updated for", user.email);
    break;
  }
  case "make-server-admin": {
    const user = values.email && findUserByEmail(db, values.email);
    if (!user) throw new Error("--email (existing login) is required");
    makeInstanceAdmin(db, user.id);
    console.log(`${user.email} now runs the server (Settings → Server)`);
    break;
  }
  case "import-grist": {
    const baseUrl = process.env.GRIST_BASE_URL;
    const apiKey = process.env.GRIST_API_KEY;
    if (!baseUrl || !apiKey || !values.doc)
      throw new Error("Set GRIST_BASE_URL and GRIST_API_KEY, and pass --doc <docId>");
    const result = await inChosenPortfolio(() => {
      seedDefaults(db);
      return importFromGrist(db, {
        baseUrl,
        apiKey,
        docId: values.doc!,
        property: values.property,
        dryRun: !!values["dry-run"],
      });
    });
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  case "backup": {
    const out = values.out ?? backupFilename();
    const b = await writeBackup(db, null, out);
    console.log(`Wrote ${out} (${(b.bytes / 1024).toFixed(0)} KB, ${b.receipts} receipts)`);
    if (b.missing.length) console.warn(`Missing receipt files: ${b.missing.join(", ")}`);
    break;
  }
  case "restore": {
    const file = positionals[0];
    if (!file) throw new Error("Usage: restore <backup.zip>");
    const r = await restoreBackup(db, null, readFileSync(file), file);
    console.log(
      `Restored ${r.transactions} transactions and ${r.receipts} receipts from ${file}.\n` +
        `Users: ${r.users_kept} kept their current sign-in, ${r.users_disabled} only in the backup (disabled), ` +
        `${r.users_added} only on this server (kept).\n` +
        `Previous data saved to ${r.previous_data_saved_as}`,
    );
    break;
  }
  default:
    console.log("Commands: create-user, set-password, make-server-admin, import-grist, backup, restore");
    process.exitCode = 1;
}
closeDb(getDb()); // restore swaps the handle
