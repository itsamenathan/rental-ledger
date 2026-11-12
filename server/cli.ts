/**
 * Admin CLI. Run inside the container with:
 *   node server/cli.ts create-user --email you@example.com --password '...' [--role admin] [--name "You"]
 *   node server/cli.ts set-password --email you@example.com --password '...'
 *   node server/cli.ts import-grist --doc <docId> [--property "My Rental"] [--dry-run]
 *       (reads GRIST_BASE_URL and GRIST_API_KEY from the environment; read-only)
 *   node server/cli.ts backup [--out backup.zip]     database snapshot + receipts
 */
import { parseArgs } from "node:util";
import { closeDb, getDb } from "./db.ts";
import { seedDefaults } from "./seed.ts";
import { createUser, findUserByEmail, setPassword } from "./services/auth.ts";
import { importFromGrist } from "./grist-import.ts";
import { createBackup } from "./services/backup.ts";
import { writeFileSync } from "node:fs";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
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
    const b = createBackup(db, null);
    const out = values.out ?? b.filename;
    writeFileSync(out, b.data);
    console.log(`Wrote ${out} (${(b.data.length / 1024).toFixed(0)} KB, ${b.receipts} receipts)`);
    if (b.missing.length) console.warn(`Missing receipt files: ${b.missing.join(", ")}`);
    break;
  }
  default:
    console.log("Commands: create-user, set-password, import-grist, backup");
    process.exitCode = 1;
}
closeDb(db);
