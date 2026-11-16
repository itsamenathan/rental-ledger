# Rental Ledger

Income and expense tracking for short-term rental properties, built for year-end taxes and for AI agents.

- **Overview charts**: month by month, running profit vs last year, where the money goes (top categories by month),
  and a year-by-year table.
- **Preparer package** (Taxes → Download for preparer): one zip per year with a plain-English Summary.txt, the
  tax summary CSV, every transaction as CSV, and the receipts named by date, category and amount.
- **Record this month's bills**: from a month page (or Add entry), add every expected recurring bill at once;
  same-every-time bills are pre-ticked, variable ones take the real amount.
- **Backup and restore** (Settings → Backup, admins): one `.zip` with a live-safe snapshot of the database plus all
  receipts. Restoring a zip replaces all data in place without a restart; the current data is saved first to
  `backups/pre-restore-*.zip` in the data folder. Sign-ins are not restored: current passwords, sessions and API
  keys are kept, and users who exist only in the backup come back disabled. CLI: `node server/cli.ts backup --out backup.zip` and
  `node server/cli.ts restore backup.zip` (stop the app before restoring from the CLI). API:
  `POST /api/backup/restore` with the zip as the body (`MAX_RESTORE_MB`, default 1024).
- **Manager statements** (Manager in the sidebar): drop in your property manager's owner-statement CSVs and invoice
  PDFs, any number at once. Each is saved under the month it covers (an invoice is placed by matching its management
  fee to a statement) and can be opened again later. The year view shows each month's status; a month's page matches
  payouts to deposits (Airbnb deposits, VRBO deposit + balance, Stripe-batched payouts) and invoice lines to expenses,
  cross-checks fees, and adds only what's missing, attaching the invoice to its entries. Agents use
  `list_manager_months`, `save_manager_document`, `preview_manager_month` and `apply_manager_month`.
- **Files** (Files in the sidebar, or "Files" on a month's page): every receipt and manager statement/invoice for a
  month or year, each with the entries it's attached to. Image preview, rename, link a file to more entries or unlink it, and
  "Download all" as a zip named by date, vendor and amount. Expenses of $75+ with nothing attached are in a collapsed
  "Needs a receipt" section; drop a file on one to attach it. Agents use `list_files`, `link_attachment`, `unlink_attachment` and
  `update_attachment`.
- **Month by month**: the overview lists every month's income, expenses and net; open a month to see it against
  last month, the same month last year and the 12-month average, with every transaction grouped by category.
- **Categories by month**: a category × month grid for the year (split by subcategory, e.g. Utilities → Electric,
  Gas, Internet), with last year's total alongside. Click any amount to see the transactions behind it.
- **Recurring bills, learned from history**: anything paid on a steady schedule (monthly, quarterly, yearly…) is
  tracked automatically. A missing payment, an exact duplicate or a changed amount is flagged on the overview;
  "Add it" pre-fills the entry, and "Nothing was due" / "Stop tracking" teach it what to ignore.
- **Category management** (Settings → Categories): add, rename, archive or delete categories (deleting one that's in
  use moves its transactions to another); add, rename (or merge) and remove subcategories across all transactions.
- **Search by amount**: `69.95`, `50-100`, `>500`, `~70` (within 10%), or type `$69.95` in the search box.
- **Quick entry** (`/add`, or press `n`): amount, date, one-tap category chips, vendor autocomplete that fills
  in the last category used for that vendor, receipt photo upload. Installable on a phone home screen.
- **Direct vs indirect** tax treatment on every expense, defaulted from its category.
- **Tax report** per year: direct and indirect totals, indirect expenses prorated by rental-use % (rental days ÷
  rental + personal days, from occupancy), Schedule E line mapping, Form 1098 mortgage-interest substitution,
  depreciation estimate, income by payer for 1099-K reconciliation, and a "before you file" checklist
  (flagged items, missing receipts, missing occupancy months, personal-use limits, 7-day average stay,
  items that may need capitalizing). Print/PDF and CSV export.
- **Occupancy** by month (booked, owner nights, check-ins).
- **To do**: one list of everything that needs a look: flagged entries, expenses with no direct/indirect set, and
  recurring-bill alerts (the nav badge counts these). $75+ expenses without receipts are counted, with a link to them on the Files page.
- **CSV import** of bank exports, with duplicate detection.
- **Users and auth**: email/password, optional OIDC (e.g. Pocket ID), roles `admin` / `member` / `viewer`.
- **Per-user API keys** (`read` or `write`) for the REST API and the **MCP server** at `/mcp`.
- **Audit log** of every change: who made it, and whether it came from the web, the API, or MCP.

## Stack

Vite+ (`vp`) · React 19 + React Router · Hono on Node 24 · SQLite (better-sqlite3) + Drizzle ORM · Zod · MCP SDK.
The server is TypeScript run directly by Node (type stripping), so there is no server build step.

```
server/
  app.ts            Hono app (API, MCP, auth)
  db.ts             connection; applies pending migrations on startup
  db/schema.ts      Drizzle schema (source of truth for tables)
  db/migrations/    generated SQL migrations (commit these)
  services/         ledger, reports (tax), rental (occupancy/tax inputs), auth, attachments
  http/             routes, middleware, MCP tools
  grist-import.ts   read-only importer from a Grist income/expense document
  cli.ts            admin CLI
src/                React SPA
```

## Development

Requires Node 24 (pinned in `.node-version`). The server and CLI run TypeScript directly, which needs a Node
built with TypeScript support. If `node -p process.features.typescript` prints `false`, let Vite+ manage Node
with `vp env on node`, or prefix commands with `vp env exec --node 24`.

```sh
vp install
vp dev            # SPA + API on http://localhost:5173 (data in ./data)
vp test           # server tests
vp check          # format, lint, type check
```

The first visit shows a setup screen that creates the admin account. You can also create it from the CLI:

```sh
node server/cli.ts create-user --email you@example.com --password '…' --name You
```

## Database changes

The schema lives in `server/db/schema.ts`. To change it:

1. Edit `schema.ts`.
2. Run `vp run db:generate --name short_description`. Drizzle Kit writes a SQL migration to `server/db/migrations/`.
3. Read the generated SQL, then commit it along with the schema change.

Pending migrations are applied automatically whenever the app opens the database (server start, `vp dev`, the
CLI), before any requests are served. A new deployment upgrades its database on first start and logs
`applied N migration(s)`. Each migration runs in a transaction; if one fails, the app does not start and the
database is left unchanged. Don't edit a migration that has already shipped; add a new one.

`vp run db:check` verifies the migration files are consistent, and `vp run db:studio` opens Drizzle Studio
against `./data/rental.db`.

## Importing from Grist

Read-only (GET requests only). Re-running updates rows that changed in Grist and skips unchanged ones
(matched by `external_id = grist:<doc>:<row>`):

```sh
GRIST_BASE_URL=https://grist.example.com GRIST_API_KEY=… \
  node server/cli.ts import-grist --doc <docId> [--property "My Rental"] [--dry-run]
```

Mapping: `Income` → `Rental Income`, `Managment Fee` → `Management Fee`, Sub_Category kept as the subcategory,
Direct/Indirect → allocation, the occupancy report table → monthly occupancy, and "<Bank> CSV import: …"
notes → that account plus the bank text as the reference.

## Production (Docker)

```sh
docker build -t rental-ledger .
docker run -d -p 3000:3000 -v rental-data:/data -e PUBLIC_URL=https://rental.example.com rental-ledger
```

See `compose.example.yaml`. Everything persistent lives in `/data` (`rental.db` plus `uploads/` for receipts);
back up that volume. Run the CLI inside the container with `docker exec <ctr> node server/cli.ts …`.

| Variable                                              | Default                         | Purpose                                                                      |
| ----------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `PORT`                                                | `3000`                          | HTTP port                                                                    |
| `DATA_DIR`                                            | `/data` (image), `./data` (dev) | Database and uploads                                                         |
| `PUBLIC_URL`                                          | –                               | External URL; used for OIDC callbacks                                        |
| `COOKIE_SECURE`                                       | `true` in production            | Set `false` only when serving plain HTTP                                     |
| `SESSION_DAYS`                                        | `30`                            | Session lifetime                                                             |
| `MAX_UPLOAD_MB`                                       | `20`                            | Receipt size limit                                                           |
| `MAX_RESTORE_MB`                                      | `1024`                          | Largest backup zip accepted for restore                                      |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | –                               | Enable SSO. Callback: `$PUBLIC_URL/api/auth/oidc/callback`                   |
| `OIDC_NAME`                                           | `SSO`                           | Button label                                                                 |
| `OIDC_AUTO_CREATE`                                    | `false`                         | Create unknown SSO users as members (otherwise the email must already exist) |
| `DISABLE_PASSWORD_LOGIN`                              | `false`                         | SSO only                                                                     |
| `DEFAULT_PROPERTY_NAME`                               | `My Rental`                     | Name of the property created in an empty database                            |

## Logging and tracing

Logs are JSON lines on stdout (pino). Set `LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`). Every
request writes one line (method, route, status, duration, user id), and every recorded change writes an `audit` line.

OpenTelemetry is off until you point it at a collector (OTLP over HTTP):

| Variable                      | Effect                                                 |
| ----------------------------- | ------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | e.g. `http://otel-collector:4318`. Turns on traces.    |
| `OTEL_EXPORTER_OTLP_HEADERS`  | e.g. `Authorization=Bearer …`                          |
| `OTEL_SERVICE_NAME`           | default `rental-ledger`                                |
| `OTEL_LOGS_EXPORTER=otlp`     | also send logs to the collector (stdout keeps working) |
| `OTEL_TRACES_EXPORTER=none`   | keep logs but turn traces off                          |

Traces: one span per API/MCP request (named by route, e.g. `GET /api/transactions/:id`), child spans for each SQL
statement and MCP tool call, and incoming W3C `traceparent` headers are honoured. Log lines inside a request carry
`trace_id`/`span_id`. Spans carry user ids, not emails, amounts or request bodies; SQL is recorded without values.

## AI agents

Create a key under **Settings → API keys & agents**, then either:

- **MCP**: `claude mcp add --transport http rental https://HOST/mcp --header "Authorization: Bearer rk_…"`.
  Tools include `add_expense`, `search_transactions`, `bulk_add_transactions` (with `dry_run`),
  `update_transaction`, `flag_for_review`, `attach_receipt`, `get_tax_report`, and `set_occupancy`.
- **REST**: the guide at `/llms.txt` describes the data model and every endpoint.

Amounts are signed (income +, expenses −). A positive amount on an expense category is rejected unless
`refund: true`, which catches the most common agent mistake. Agents should set `needs_review` with a
`review_note` when unsure; those entries appear on the To do page.
