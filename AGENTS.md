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
  on startup (`runMigrations` in `server/db.ts`), all in one transaction with foreign keys off (the
  `PRAGMA foreign_keys=OFF` drizzle-kit writes does nothing inside a transaction); `foreign_key_check` runs after a
  migration and logs broken references.
  drizzle-kit's `ADD COLUMN … NOT NULL` without a default fails on tables with rows: fill it in the unapplied
  migration (see `0017_portfolios.sql`).
- Use `tx(db, fn)` from `server/db.ts` for multi-statement writes; nested calls join the outer transaction.
- Portfolios (`docs/plans/portfolios.md`): one person's or household's properties together. Properties, transactions,
  categories, receipt rules, import profiles, recurring dismissals, pending uploads, API keys and audit entries
  belong to one portfolio (`portfolio_id`; everything else hangs off a property). Logins, sessions and preferences
  are per login (`memberships` say which portfolios a login can open, with a role in each); backups are whole-server
  (instance admin only). The request's portfolio is the API key's, or `?portfolio=<slug>` (else the login's only
  one), set by `resolveActor` in `server/http/middleware.ts` and held in AsyncLocalStorage (`server/portfolio.ts`);
  services read it with `currentPortfolioId(db)`, which outside a request (CLI `--portfolio`, tests, seeding) is the
  only portfolio, or what `inPortfolio(id, fn)` says. `actor.user.role` is the membership's role, so `requireAdmin`
  means portfolio admin; `requireInstanceAdmin` (`users.is_instance_admin`; `users.role` is unused) is for creating
  portfolios, changing logins (password, disabled, name: they reach every portfolio) and backups. The instance admin
  can open any portfolio read-only; `recordInstanceAdminView` notes it in that portfolio's audit log once a day.
  People join only by invite link (`server/services/invites.ts`: hashed one-time token, 7 days, revocable; signed in
  = joins with that login, never matched by email; SSO sign-up carries the token in the OIDC cookie). A portfolio
  always keeps an admin. `server/services/portfolios.ts` has members, server-wide screens and portfolio creation
  (seeded inside `inPortfolio`; startup only seeds a lone portfolio, `seedFirstRun`). Every query on portfolio data filters by it: `txInPortfolio`, `categoriesInPortfolio`, or
  `propertyScope(db, col, propertyId)` instead of `propertyId ? eq(col, propertyId) : undefined`; lookups by id
  include it, so another portfolio's id is a 404. Stored-file reference counting and backup/restore are the
  deliberate exceptions. `server/portfolios.test.ts` calls every REST route and MCP tool as one portfolio looking for
  the other's canary values: add ids for a new `:id` route there.
- Properties are separate books within a portfolio. Transactions, occupancy, calendars, tax years and manager
  paperwork belong to one property. Services take an optional `propertyId` (undefined = every property of the
  portfolio); REST/MCP resolve it with `resolvePropertyId` (writes and per-property reads) or `resolvePropertyScope`
  (reads that may add up, `property=all`). A missing property only falls back to the sole active one; with several
  it's a 400, never a guess.
- Client portfolio: the app runs under `/<portfolio slug>/` (React Router `basename`, `src/portfolio.ts`), so links and
  routes don't mention it; switching portfolios is a full page load. Every API URL goes through `apiUrl()` (which `api()`
  uses) to add `?portfolio=<slug>`: wrap any `/api/…` href and server-sent `url`/`preview_url` in it. Slugs are readable, made from
  the name (`server/slugs.ts`, shared with the app): unique, kept on rename, changeable ("Web address": a property's by anyone who can write, the portfolio's by the instance admin only, since a "taken" answer would reveal other portfolios), and
  never one of `RESERVED_PORTFOLIO_SLUGS` (server routes, built files, app pages; `server/slugs.test.ts` checks the list
  against `createApp()`'s routes, `public/` and `App.tsx`, so add a new top-level route or page there). Migration
  0017 leaves existing properties' slugs empty and `fillSlugs` (`server/db.ts`, after every migrate) fills them. A page whose first
  segment is reserved (old links like `/transactions` or `/p/<id>/…`, the installed app's start) goes to the last
  portfolio used (`portfolio-last`), or the only one; a portfolio the login can't open goes to the start of one it can;
  `/invite/<token>` renders outside any portfolio. Per-portfolio localStorage keys use `portfolioKey()`. Outbox
  entries carry their portfolio's `portfolio_id` (not the slug, which can change) and replay into it, older ones into
  portfolio 1 (`setOutboxPortfolios`); the service worker caches `auth/me`/`overview`/`suggestions`
  per `?portfolio=`. Words: the UI says **portfolio** for several properties together ("Other portfolios", "All
  portfolios", "You don't have access to this portfolio"), never "books" (which only means a property's own
  accounting), and error messages that reach the UI say the same. The portfolio's name and its General page always
  show, even with one. Settings is grouped by whom a page affects (`Settings()` in `src/pages/Settings.tsx`): Your
  account (Account, Preferences), Portfolio (General — rename, web address, leave —, Properties, Categories, Who has
  access, API keys & agents, Change history = this portfolio's audit log, Download everything =
  `GET /api/export/portfolio.zip` from
  `server/services/portfolio-export.ts`, the people's own copy since a backup holds everyone) and Server (instance admin only, `/settings/server/*`: All portfolios, Logins, Backup &
  restore, Server activity = `GET /api/admin/audit`). Put a new page in the group whose scope it changes; the
  portfolio pages are in `src/pages/Portfolios.tsx`. Change history labels access entries in plain words
  (`describeAccess` in Settings.tsx). The shell's one picker (`PropertySwitcher`) lists this portfolio's properties
  and, under "Other portfolios", the login's other portfolios. A refusal because the caller has no access to this
  portfolio carries `details.code = "no_access"`; `api()` then fires `PORTFOLIO_LOST_EVENT` and the app forgets the
  portfolio and starts over at `/`.
- In the app every page lives under `/<property slug>/…` inside the portfolio (`/all/…` for Overview, Month, Categories,
  Recurring, To do, Transactions, Files; `ALL_PAGES` in `src/scope.ts`), e.g. `/alexs-portfolio/harbor-view/occupancy`.
  Property slugs are unique per portfolio, made like portfolio slugs, never `all`/`settings`/`p` or a bare number (a number
  is an old id: `/p/<id>/…` and `/<id>/…` redirect to the slug). `useProperty().key` stays the id (or "all") for
  `qs`, the picker and storage; `.segment` is what goes in the URL. Build links with `useScopedPath()` (another property's page, e.g. a To do row's:
  `usePropertyPath()(propertyId, to)`, never the id in the URL) and send `useProperty().qs`
  on API calls; the shell's `PropertySwitcher` is the only property picker (hidden with one active property). Old
  URLs redirect to the last property used. `/settings` is the login's and the portfolio's (Account, Preferences,
  People, Server…); `/<property slug>/settings` is the property's own.
- Starter categories (`DEFAULT_CATEGORIES` in `server/seed.ts`) are the lines of the tax preparer's rental worksheet,
  each with a Schedule E line and a direct/indirect `default_allocation` that a new entry takes unless it names one
  (any entry can override it). Tests of ledger logic seed the fixed `TEST_CATEGORIES` (`server/test-categories.ts`)
  instead, so changing the starters doesn't touch them.
- PATCH bodies go through `parsePatch` in `ledger.ts`: zod 4 fills `.default()` values even inside `.partial()`.
- User preferences (`server/services/user-settings.ts`): a person's own UI choices live as JSON in `users.settings`,
  not on the property or app-wide. To add one, put its validator in `fields` and its default in `DEFAULTS`; no
  migration. Only changed keys are stored; reads fall back to the default per key and never throw (`auth/me` returns
  them, so a bad value mustn't look like being signed out). `PATCH /api/auth/settings` merges only the sent keys, is
  browser-session only (viewers allowed, API keys 403) and REST only like uploads, and audits before/after. Client:
  `useSession().settings` / `updateSettings`, edited in Settings → Preferences. `week_start` (Sun/Mon/Sat, default
  Sunday) drives the Calendar grid via `monthWeeks`/`weekdayNames` in `src/calendar.ts`.
- Month page (`src/pages/Month.tsx`, `src/components/MonthTransactions.tsx`): the Transactions card's filter chips,
  search, category, date order and List/By category layout live in the URL (`show`, `q`, `cat`, `sort`, `view`;
  `src/month-view.ts`, defaults left out) and are applied in the browser to the month's entries. The search and
  filters mean the same as the API's `q`/`kind`/`needs_review`/`needs_receipt`/`category`, so "Export CSV" sends them
  and downloads what's on screen. Month links and Add's `back` keep the view. `listTransactions` adds `needs_receipt`
  to each item (from `missingReceiptIds`, never a second rule). Row flag/receipt buttons use the normal PATCH and
  attachments routes (online only; no outbox). The recurring card folds done bills away and becomes one line when
  nothing needs attention.
- Transactions page (`src/pages/Transactions.tsx`) uses the same rows as the Month page (`TxRow` in
  `src/components/TxRows.tsx`: flag/receipt popovers, offline-pending note, optional select checkbox) and the same
  chips/search/order controls, but filters and pages on the server with the API's own params (`kind`, `needs_review`,
  `needs_receipt`, `sort=date_desc`…, not `month-view.ts`), so links from To do, Reports, Files etc. keep working.
  Less-used filters sit behind "Filters"; in date order rows are grouped under month headings that link to the Month
  page. Its chip numbers come from `counts=true` on the list (`transactionCounts`: the other filters, without
  kind/needs_review/needs_receipt). Every list of entries uses `TxRow` (Overview's Recently changed, Add's "Added just
  now" via the list's `ids` filter, Files' "Needs a receipt" with `onDropFiles` and its link picker with
  `actions: false`), and entries are named by `txParts` everywhere (Files, To do, the edit dialog, toasts); recurring
  series use the same rule on the server (`labelOf`: vendor · subcategory, else the category). Files has the Month
  page's `MonthPicker` and the same `tx-tools` search row. "Select" + `BulkBar` (`useTxSelection` in hooks.ts) is on both Month and Transactions
  and acts only on the ticked entries still on screen.
- Shared UI rules: months are changed only with `MonthNav` (‹ `MonthPicker` ›, links, so the month is in the URL and
  Back steps through them) on Month, Files, Calendar (`?month=`, else the last one viewed) and the Manager month page;
  years only with `YearSelect`. Overview, Categories, Occupancy, Transactions (no `?year`) and the Manager list share
  one remembered year (`useWorkingYear`, key `dash-year`); the tax report keeps its own on purpose. Anything that can
  be undone acts at once and offers Undo in the toast (entry delete, bulk delete, owner stays, unlink); anything else
  asks with `useConfirm()` (the app's dialog, `ConfirmProvider` in lib.tsx; focus on Cancel when `danger`), never
  `window.confirm`. Folding sections use `<details>`/`<summary>` (shared ▸/▾ marker in index.css) or a
  `.section-toggle` button with a `.fold-mark`.
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
- A payout that "differs" (a deposit near the stay, close to but not the statement's amount) is flagged for review
  when the month is saved (apply), once per transaction: the ids go in `flagged` on the `manager_statement` audit row,
  so a flag cleared by hand stays cleared. Its warning spells out the difference and the management fee's likely share.
- Manager warnings can be "marked as explained" (`manager_acknowledgements`, keyed by a hash of the warning text, so
  changed amounts ask again; when rewording a warning, keep hashing the old wording, as `legacyDifferenceText` does). Months with entries to add or unexplained warnings count on the To do page.
- Stored files go through `server/services/storage.ts`: identical bytes share one file across `attachments`,
  `manager_documents` and `pending_uploads`; delete rows first, then `releaseFile`. Backups include every key from all
  three tables. `storeBytes(db, data, ext, save)` takes a synchronous `save(key)`
  that writes the row(s) in the same tick as the lookup of an existing file (no `await` between them), so a
  concurrent `releaseFile` can't delete a file that's about to be referenced.
- Zip downloads stream through `gatedZipStream`/`zipStream` in `server/services/zip.ts` (files read and compressed
  one at a time, off the event loop); never build a whole archive in memory. Restores inflate one entry at a time.
- Restore swaps the database handle and uploads folder inside `exclusive()` from `server/maintenance.ts`: API/MCP
  requests, streamed downloads and the scheduler hold the gate (`enter()`), so new work gets a 503 and running work
  finishes first. Background work outside a request must hold the gate too.
- Receipts picked in the entry form upload right away to `pending_uploads` (`server/services/uploads.ts`,
  `POST /api/uploads`) and are attached by `upload_ids` on create/update inside the save's transaction; the form
  discards them when closed unsaved (`src/receipt-uploads.ts`), and stale ones are pruned after 24 hours. REST only.
- Document scanner (`src/scanner/`, entry form's "Scan" button): runs entirely on the device. Where the browser
  allows a live camera (https or localhost, `live-camera.ts`), Scan opens the scanner's own viewfinder (`Camera.tsx`,
  getUserMedia; the photo is the frame on screen, from a 2560×1920-ideal stream, because `ImageCapture.takePhoto`
  took 2–4 s per shot on Android; `camera-pick.ts` moves off a back lens that can't focus, often the ultra-wide, and
  remembers the camera in localStorage; tap to focus; the Scan/Photo tap starts the camera, `warmCamera`, while the
  screen appears, and `ReceiptPicker` fetches both screens while the form is open, not React.lazy, which holds a screen
  back ~300 ms; Back closes them via a history entry, `useBackCloses`) so several pages never leave the page. The "Photo" button uses the same viewfinder for plain photos
  (`PhotoCamera.tsx`, `burst`: several in a row, Done attaches them; "Camera app" hands over to the phone's camera from
  the tap, keeping what was taken); elsewhere, or when the camera
  is refused, it uses the phone's camera app through a capture input. The camera runs only on the camera step (all
  tracks stopped on leaving it or when the page is hidden). A multi-page scan is one PDF; the scanner sends a JPEG of
  its first page as `preview` with the upload, stored in `file_previews` by the file's sha256 (in the database, so
  backups carry it; orphans dropped by `releaseFile`) and served at `/api/attachments/:id/preview` (`has_preview`,
  `preview_url` on the Files page). Receipts queued offline go without a preview. Page finding,
  flattening and filters are plain TypeScript (`detect.ts`, `image.ts`; no DOM, tested in Node). OpenCV.js was
  tried and dropped: loading it alone took ~700 MB and phones killed the page. `detect.ts` scores candidate outlines
  (Hough lines + bright regions) on edge support, paper-likeness, size and angles, then refits each side; check
  changes with `scripts/scanner-eval/` (labelled photo sets) and `detect.test.ts`, not one picture. Memory: one working copy of the photo (≤2400 px; pages ≤3 MP), each
  finished page kept only as JPEG; free temporary canvases (`free()` in `canvas.ts`). pdf-lib joins pages (one page
  = JPEG) and tesseract.js reads the text; `receipt-total.ts` picks the total and date, which only fill a new
  entry's empty amount / untouched date. The tesseract worker/core and `eng.traineddata` are self-hosted hashed build
  files (never a CDN) kept out of the service worker's install list: `isScannerAsset` in `vite.config.ts` →
  `SCANNER_ASSETS`, cached on first use in `scanner-v1`. The build writes `.gz` copies of scripts/styles that
  `server/main.ts` serves (`precompressed`). tesseract.js 7 can't take the model as data (its init uses `data` as
  the language name), so `ocr.ts` passes the hashed model URL as `langPath` with a `#` on the end. These packages
  are devDependencies: they only feed the build, not the server.
- The Files page (`server/services/files.ts`) lists one item per stored file (sha256) with every entry it's attached
  to: receipts by their entry's date, manager paperwork by the month it covers. Trashed entries are left out.
- "Needs a receipt" is decided only by `needsReceipt()` in `server/services/receipts.ts`: the subcategory's rule
  (`subcategories.receipt_policy`/`receipt_min`, null = same as the category) else the category's
  (always/threshold/never + optional `receipt_min`), minus vendors on the `receipt_exclusions` never-ask list. To do,
  Files, the tax report check and the `needs_receipt` transaction filter all use it; don't add another amount filter
  for receipts. Setting a rule on a used-only subcategory saves its `subcategories` row first.
- Subcategories are free text on transactions (Grist layout, e.g. Management Fee → Acme PM). The `subcategories`
  table only remembers names for suggestions; rename/remove/merge go through `server/services/categories.ts`.
- Booking calendar (`server/services/calendar.ts`): feed events are upserted by uid on each sync; a missing event is
  deleted only if it hasn't ended (cancelled). Older stays come from `calendar_events` rows with `source = 'history'`
  (an imported Airbnb reservations CSV, `feed_id` null, uid = confirmation code, past stays only; syncs never touch
  them) and from saved manager statements (derived on every read, negative ids, nothing stored). `listEvents` drops a
  reservation that overlaps one from a higher source (feed > history > statement). The production server refreshes
  linked feeds every `CALENDAR_REFRESH_MINUTES` (`server/scheduler.ts`, started in `main.ts`, never in `vp dev`).
- Calendar grid (`src/pages/Calendar.tsx`): each reservation is a bar from the middle of its check-in day to the
  morning of its checkout day (Hostaway style; `CHECK_IN_AT`/`CHECK_OUT_AT` are assumed, not a setting), built from `nights` and cut per
  week row; click the bar, not the day. The page loads the month before and after so bars reach the greyed days.
- Owner stays (`server/services/owner-stays.ts`, `owner_stays`): personal-use stays by date, end_date = checkout day
  (not a night), each night counted in its own month/year. Occupancy stays the record of rental/personal days, but
  owner_nights is derived on read: for a (property, month) with any stay night it is the stays' nights, else the
  stored number. Every read goes through `occupancyRows` (listOccupancy, `occupancyTotals`, summary, month detail,
  tax report); never sum `occupancy.owner_nights` directly. `upsertOccupancy` keeps the stored owner_nights for months
  with stays (the UI locks the cell), so deleting the last stay brings the typed number back. Months with stays but no
  saved row add personal nights only (no available nights; `missing_occupancy` still fires). Overlapping stays in one
  property are refused; overlapping guest nights only warn.
- Calendar → occupancy (`server/services/occupancy-calendar.ts`) never writes on its own. `compareOccupancyCalendar`
  reads `calendarMonths` (shared with `getCalendar`) and offers only ended months with a calendar reservation;
  `incomplete` lists feeds whose earliest event starts after the month began (Airbnb's ~60-day export) unless
  reservation history covers it, and the tax report's "before you file" item skips those months.
  `applyCalendarToOccupancy` writes only nights_booked/check_ins through `upsertOccupancy` (passing the stored
  owner_nights/notes/available through, since zod fills defaults) and skips lower calendar numbers without
  `confirm_lower`. "Keep mine" (`keepOccupancyNumbers`, `occupancy_calendar_keeps`) snapshots both sides' nights and
  check-ins; `MonthCompare.kept` is set only while they still match, so a change on either side asks again. Kept months
  leave To do and the tax report check. Differing months carry `stays` (the reservations counted) for the To do row. `ownerStayCandidates` groups block-held nights (no reservation from any source) while they share a
  block event; only feeds whose data reaches the range vote (strong = blocked on every covering feed, unclear = one
  covering feed, weak = open on another feed, a 1-night block next to a guest, or > 31 nights). "Not a stay" is
  `owner_stay_dismissals` (exact start/end). The confident items (strong blocks, and fully covered months that
  differ, this year and last) are To do items via `occupancyAttention` and count in the badge; the Occupancy page
  only links to them and keeps the less certain blocks behind "Pick from blocked calendar dates".
- Fetch user-supplied URLs (calendar feeds) only through `safeDownload` in `server/services/safe-download.ts`: it
  refuses private/loopback addresses at connect time and on every redirect (`CALENDAR_ALLOW_PRIVATE_NETWORK` opts out).
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

Each worktree gets its own throwaway `./data` with fictional data and known logins. Portfolio "Alex's portfolio" has Harbor
View Cottage (about 3 years
of transactions, receipts, occupancy, and To do items: a missing bill, a duplicate, a flagged and an unallocated
entry) and a smaller Pine Ridge Cabin (2 years, its own calendar and one flagged entry), so the property switcher and
`/alexs-portfolio/all` have something to show. T3 Code runs
`scripts/harness setup` when it creates a worktree.

- `scripts/harness dev` starts `vp dev` on 0.0.0.0 at this worktree's own port (stable per path, printed and stored in
  `data/harness.json`). `scripts/harness reset` reseeds; stop the dev server first (reset refuses while it runs).
- `scripts/harness preview` builds and runs the production server on the same port and data. Use it for anything
  that needs the service worker (installing, offline mode, the outbox); `vp dev` doesn't register one.
- `scripts/harness dev` and `preview` also put the server behind `tailscale serve` while they run, with a real
  certificate, at `https://<this machine>.<tailnet>.ts.net:<port + 10000>` (tailnet only; printed at start, removed on
  exit; `HARNESS_HTTPS=0` skips it, and a failure only prints a note). Browsers only allow the live camera and the
  service worker on https or localhost, so use it to try the scanner/camera or the installed app from a phone. It needs
  `sudo tailscale set --operator=$USER` once, and `server.allowedHosts` in `vite.config.ts` allows `.ts.net` hosts.
  `scripts/harness https [off]` does the same for a server started some other way. The dev port itself can't be reused
  for https: the server listens on every interface.
- Logins: `admin@example.com`, `member@example.com`, `viewer@example.com`, password `password`. A second portfolio,
  "Jordan's rentals" (Lakeside Duplex, six months of entries), belongs to `jordan@example.com`; `member@` is in both
  (the portfolio switcher shows), and `admin@` runs the server (Settings → Server, and a read-only look into Jordan's).
- `scripts/harness info` prints the URL, a write and a read API key (`Authorization: Bearer …`), an admin session
  cookie for curl, `data/sample-bank-export.csv` for trying CSV import, `data/sample-airbnb.ics` (one new
  reservation) for trying "Import .ics file" on the Calendar page, and `data/sample-airbnb-reservations.csv` for
  "Import reservations CSV" (Settings → property). Like the real export, Harbor View's Airbnb feed only has the last
  60 days of past stays, so older Airbnb stays show only as VRBO blocks until that CSV is imported.
- Reset only deletes a data folder the harness created (it has `harness.json`), never a real ledger.
- Run Node commands through `vp env exec --node 24 …` if `node -p process.features.typescript` prints `false`.
- When a change needs new kinds of data to test, add it to `generate()` in `server/harness.ts`.
