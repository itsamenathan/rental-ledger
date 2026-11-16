<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Project notes

- Server: `server/` is TypeScript executed directly by Node 24 (type stripping). Use `.ts` import extensions and
  erasable syntax only (no enums or parameter properties). In dev it runs inside `vp dev` through the
  `rental-dev-api` plugin in `vite.config.ts`.
- All business logic lives in `server/services/*`. REST (`server/http/api-routes.ts`) and MCP (`server/http/mcp.ts`)
  are thin wrappers, so add features there first and expose them in both.
- Every write goes through a service function that calls `audit()`. Amounts are stored as signed integer cents.
- Database: Drizzle ORM over better-sqlite3 (synchronous). Tables are defined in `server/db/schema.ts`; queries use the
  Drizzle query builder, and API responses keep snake_case field names via select aliases.
- Schema changes: edit `server/db/schema.ts`, then `vp run db:generate --name <change>`, review the SQL in
  `server/db/migrations/`, and commit both. Never hand-write or edit an applied migration. Migrations apply automatically
  on startup (`runMigrations` in `server/db.ts`).
- Use `tx(db, fn)` from `server/db.ts` for multi-statement writes; nested calls join the outer transaction.
- Recurring-bill detection (`server/services/recurring.ts`) is computed from history on each request; the only stored
  state is user feedback in `recurring_dismissals` (month = '' means stop tracking the series). Tests in
  `server/recurring.test.ts` pin the rules with a fixed `today`.
- Manager paperwork: statements/invoices are saved per month in `manager_documents` (file + text, re-parsed on every
  review) by `server/services/manager-documents.ts`; reconciliation is in `server/services/manager-statement.ts`.
  Payout matching runs across every saved statement at once (`managerContext`), so a deposit goes to the stay it
  belongs to whichever month is viewed. Airbnb = one deposit; VRBO = ~30% deposit + balance, or batched in Stripe
  transfers (never offered for creation). Invoice lines are matched one-to-one by amount + category (not `bulkCreate`,
  which would drop equal-amount lines). Never touch `external_id`/`reference` on existing rows; manager names are never
  hard-coded (CSV columns match by suffix, the subcategory comes from history).
- Manager warnings can be "marked as explained" (`manager_acknowledgements`, keyed by a hash of the warning text, so
  changed amounts ask again). Months with entries to add or unexplained warnings count on the To do page.
- Stored files go through `server/services/storage.ts`: identical bytes share one file across `attachments` and
  `manager_documents`; delete rows first, then `releaseFile`. Backups include every key from both tables.
- The Files page (`server/services/files.ts`) lists one item per stored file (sha256) with every entry it's attached
  to: receipts by their entry's date, manager paperwork by the month it covers. Trashed entries are left out.
- "Needs a receipt" is decided only by `needsReceipt()` in `server/services/receipts.ts`: the subcategory's rule
  (`subcategories.receipt_policy`/`receipt_min`, null = same as the category) else the category's
  (always/threshold/never + optional `receipt_min`), minus vendors on the `receipt_exclusions` never-ask list. To do,
  Files, the tax report check and the `needs_receipt` transaction filter all use it; don't add another amount filter
  for receipts. Setting a rule on a used-only subcategory saves its `subcategories` row first.
- Subcategories are free text on transactions (Grist layout, e.g. Management Fee → Acme PM). The `subcategories`
  table only remembers names for suggestions; rename/remove/merge go through `server/services/categories.ts`.
- Logging: use `log` from `server/telemetry.ts` (pino), not `console.*` (the CLI's human output is the exception).
  Tracing is automatic for API/MCP requests and SQL; wrap other slow work in `withSpan(name, attrs, fn)`.
- Never write to Grist; `server/grist-import.ts` must stay GET-only.
- Installed app / offline: `pwa/service-worker.js` is emitted as `dist/sw.js` by the `rental-service-worker` plugin in
  `vite.config.ts` (production builds only, so test it with `scripts/harness preview`, not `dev`). It caches the app
  shell, `auth/me`, `overview`, `suggestions` and the last 150 transaction list/entry responses; it never handles
  writes. Work saved without a connection waits in IndexedDB (`src/outbox.ts`): new entries replay with a `client_id`
  (`createTransaction` returns the existing row), edits send only changed fields plus `expected_updated_at`, and the
  server answers 409 with the current row in `details.current` when the entry changed since ("Keep mine" / "Keep
  theirs" in the outbox list).

# Test harness (worktrees)

Each worktree gets its own throwaway `./data` with fictional data (about 3 years of transactions, receipts, occupancy,
and To do items: a missing bill, a duplicate, a flagged and an unallocated entry) and known logins. T3 Code runs
`scripts/harness setup` when it creates a worktree.

- `scripts/harness dev` starts `vp dev` on 0.0.0.0 at this worktree's own port (stable per path, printed and stored in
  `data/harness.json`). `scripts/harness reset` reseeds; stop the dev server first (reset refuses while it runs).
- `scripts/harness preview` builds and runs the production server on the same port and data. Use it for anything
  that needs the service worker (installing, offline mode, the outbox); `vp dev` doesn't register one.
- Logins: `admin@example.com`, `member@example.com`, `viewer@example.com`, password `password`.
- `scripts/harness info` prints the URL, a write and a read API key (`Authorization: Bearer …`), an admin session
  cookie for curl, `data/sample-bank-export.csv` for trying CSV import, and `data/sample-airbnb.ics` (one new
  reservation) for trying "Import .ics file" on the Calendar page.
- Reset only deletes a data folder the harness created (it has `harness.json`), never a real ledger.
- Run Node commands through `vp env exec --node 24 …` if `node -p process.features.typescript` prints `false`.
- When a change needs new kinds of data to test, add it to `generate()` in `server/harness.ts`.
