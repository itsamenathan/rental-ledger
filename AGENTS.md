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
- Properties are separate books. Transactions, occupancy, calendars, tax years and manager paperwork belong to one
  property; users, API keys, categories, receipt rules, import profiles and backups are app-wide. Services take an
  optional `propertyId` (undefined = every property); REST/MCP resolve it with `resolvePropertyId` (writes and
  per-property reads) or `resolvePropertyScope` (reads that may add up, `property=all`). A missing property only
  falls back to the sole active one; with several it's a 400, never a guess.
- In the app every page lives under `/p/<id>/…` (`/p/all/…` for Overview, Month, Categories, Recurring, To do,
  Transactions, Files; `ALL_PAGES` in `src/scope.ts`). Build links with `useScopedPath()` and send `useProperty().qs`
  on API calls; the shell's `PropertySwitcher` is the only property picker (hidden with one active property). Old
  URLs redirect to the last property used. `/settings` stays app-wide; `/p/<id>/settings` is the property's own.
- PATCH bodies go through `parsePatch` in `ledger.ts`: zod 4 fills `.default()` values even inside `.partial()`.
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
- Invoice repeats (`server/services/invoice-repeats.ts`): each month's invoice lines are compared with the property's
  earlier saved invoices (parsed once in `managerContext().invoices`) at the detail level: `description` split on
  "; " into sub-items, normalized by `normalizePhrase` (months, years, dates, punctuation, a leading "(2)"/"2 x"
  stripped; a plain leading number kept). Amounts count only where a sub-item carries its own price; a line with no
  comparable detail is compared as item + amount. Recurring = the phrase is on 3+ months' invoices counting only
  months up to the one reviewed, never later ones (a later invoice must never change an earlier month's warnings).
  Same-month invoices are compared in (issued, saved) order; an invoice passed in directly is never compared with its
  saved copy (same number). Waiver/commission lines are skipped (reconciled against the statement). "Was scheduled
  in August" only warns if August's invoice billed the same item. Warnings are checks with `phrase`; "This recurs" is
  `invoice_repeat_dismissals` (per property, by normalized phrase), "Explained" is the usual acknowledgement.
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

Each worktree gets its own throwaway `./data` with fictional data and known logins: Harbor View Cottage (about 3 years
of transactions, receipts, occupancy, and To do items: a missing bill, a duplicate, a flagged and an unallocated
entry, plus last month's manager invoice with lines to add and three "billed again" warnings) and a smaller Pine Ridge Cabin (2 years, its own calendar and one flagged entry), so the property switcher and
`/p/all` have something to show. T3 Code runs
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
- Logins: `admin@example.com`, `member@example.com`, `viewer@example.com`, password `password`.
- `scripts/harness info` prints the URL, a write and a read API key (`Authorization: Bearer …`), an admin session
  cookie for curl, `data/sample-bank-export.csv` for trying CSV import, `data/sample-airbnb.ics` (one new
  reservation) for trying "Import .ics file" on the Calendar page, and `data/sample-airbnb-reservations.csv` for
  "Import reservations CSV" (Settings → property). Like the real export, Harbor View's Airbnb feed only has the last
  60 days of past stays, so older Airbnb stays show only as VRBO blocks until that CSV is imported.
- Reset only deletes a data folder the harness created (it has `harness.json`), never a real ledger.
- Run Node commands through `vp env exec --node 24 …` if `node -p process.features.typescript` prints `false`.
- When a change needs new kinds of data to test, add it to `generate()` in `server/harness.ts`.
