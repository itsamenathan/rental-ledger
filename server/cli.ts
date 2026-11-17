/**
 * Admin CLI. Run inside the container with:
 *   node server/cli.ts create-user --email you@example.com --password '...' [--role admin] [--name "You"]
 *   node server/cli.ts set-password --email you@example.com --password '...'
 *   node server/cli.ts import-grist --doc <docId> [--property "My Rental"] [--dry-run]
 *       (reads GRIST_BASE_URL and GRIST_API_KEY from the environment; read-only)
 *   node server/cli.ts backup [--out backup.zip]     database snapshot + receipts
 *   node server/cli.ts restore backup.zip            replace all data (stop the app first, or use the web UI)
 */
import { parseArgs } from "node:util";
import { closeDb, getDb } from "./db.ts";
import { seedDefaults } from "./seed.ts";
import { createUser, findUserByEmail, setPassword } from "./services/auth.ts";
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
  },
});

const { values, positionals } = parsed;
const db = getDb();

switch (command) {
  case "create-user": {
    if (!values.email) throw new Error("--email is required");
    seedDefaults(db);
    const user = await createUser(db, null, {
      email: values.email,
      name: values.name ?? "",
      password: values.password,
      role: (values.role as "admin" | "member" | "viewer") ?? "admin",
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
  case "import-grist": {
    const baseUrl = process.env.GRIST_BASE_URL;
    const apiKey = process.env.GRIST_API_KEY;
    if (!baseUrl || !apiKey || !values.doc)
      throw new Error("Set GRIST_BASE_URL and GRIST_API_KEY, and pass --doc <docId>");
    seedDefaults(db);
    const result = await importFromGrist(db, {
      baseUrl,
      apiKey,
      docId: values.doc,
      property: values.property,
      dryRun: !!values["dry-run"],
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
    console.log("Commands: create-user, set-password, import-grist, backup, restore");
    process.exitCode = 1;
}
closeDb(getDb()); // restore swaps the handle
