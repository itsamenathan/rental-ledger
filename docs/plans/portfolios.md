# Portfolios: other people's rentals in the same app

A **portfolio** is one person's (or household's) properties together: their properties, categories, receipt rules, import
profiles, recurring-bill feedback, uploads and audit log. A login belongs to one or more portfolios through a
**membership** with a role. ("Owner" is avoided in code: it already means owner stays / owner payouts.)

Invite-only and self-hosted. No public signup.

## Data model: one database, `portfolio_id` on what needs it

Not a database per portfolio. One SQLite file, with guardrails so that a forgotten filter doesn't leak data.

- New tables: `portfolios`, `memberships(user_id, portfolio_id, role)`, later `invites`.
- `portfolio_id` on `properties` and `transactions`. Transactions need their own copy because bank-import dedupe
  (`external_id`) is per portfolio across all its properties: a joint account imported into two portfolios must
  work in both. Composite foreign keys `transactions(property_id, portfolio_id)` → `properties(id, portfolio_id)` and
  `transactions(category_id, portfolio_id)` → `categories(id, portfolio_id)` let SQLite refuse an entry whose
  property or category is in another portfolio.
- Everything else that hangs off a property (occupancy, calendars, tax years, manager paperwork, owner stays,
  attachments) is scoped through it: `resolvePropertyId`/`resolvePropertyScope` accept only properties in the
  caller's portfolio, and `property=all` means all of the caller's portfolio.
- `portfolio_id` on today's app-wide tables: `categories` (subcategories follow their category),
  `receipt_exclusions`, `import_profiles`, `pending_uploads`, `audit_log`, `api_keys`. `recurring_dismissals` series
  keys start with the property id; check the reads.
- Uniques that become per portfolio: `transactions.external_id`, `transactions.client_id`, and the `lower(name)`
  indexes on properties, categories, receipt_exclusions and import_profiles.
- Stays per login: `users`, `sessions`, `users.settings`.
- Stored files stay shared by sha256 on disk; they are only reachable through an attachment / manager document /
  pending upload row in the caller's portfolio, so knowing a hash gives nothing. Reference counting (`storeBytes`'s
  lookup, `releaseFile`, `allStorageKeys`, `dropOrphanPreviews`) and backup/restore stay deliberately unscoped, or a
  file still used by another portfolio would be deleted.
- Migration backfills every existing row into portfolio 1. The one existing user becomes its admin and the instance
  admin.

### Guardrails

1. **The current portfolio is request context.** Auth puts it in AsyncLocalStorage; `currentPortfolioId()` reads it.
   Without one (CLI, scheduler, tests) it is the only portfolio, and throws once there are several, like
   `resolvePropertyId`. Threading `portfolioId` through 136 service signatures would add no safety: a forgotten
   filter would still compile.
2. **One helper for property scope.** `propertyScope(db, col, propertyId)` replaces every
   `propertyId ? eq(col, propertyId) : undefined`: one property, else every property of the current portfolio (a
   given property is checked against the portfolio too). A grep-based lint for raw ternaries was considered and left
   out: the canary test below catches the same mistakes with fewer false alarms.
3. **The database refuses cross-portfolio links** (the composite foreign keys above).
4. **Lookups by id check the portfolio** (transactions, attachments, categories, import profiles, documents, …):
   another portfolio's id is a 404, same as a missing one. Other places that take an id or key from the request
   and must check: audit undo (`POST /audit/:id/undo`), `upload_ids` on create/update, the `client_id` replay
   lookup, the Files page's grouping by sha256 (a receipt uploaded in both portfolios must not list the other's
   entries), suggestions, `external_id` dedupe.
5. **Canary test.** Seed portfolio B with distinctive values (vendor, category, property name, an odd amount, a
   filename) and one receipt with the same bytes as one of A's. Call every REST GET route and every MCP read tool as
   A and assert no canary appears; call every `:id` route with B's ids and expect 404. List and summary endpoints
   leak with a 200, so the canaries matter more than the 404s.

## Roles

- Per membership: admin / member / viewer (as today). A tax preparer is a viewer.
- `users.is_instance_admin`: creates and archives/deletes portfolios, sees all logins, runs instance backups and
  restores. Can **open any portfolio read-only**; each visit is audited in that portfolio's log
  (`view` by instance admin, at most once per portfolio per day), visible to its admins.
- Portfolio admin: members and invites, categories and rules, properties, portfolio settings.
- No per-property access inside a portfolio: the portfolio is the boundary.

## Decisions

| #   | Question                             | Decision                                                                                     |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1   | Who creates portfolios               | Instance admin only                                                                          |
| 2   | Who invites                          | That portfolio's admins                                                                      |
| 3   | Instance admin seeing portfolios     | Yes, read-only, audited in the portfolio                                                     |
| 4   | Roles                                | admin / member / viewer per portfolio                                                        |
| 5   | Per-property access                  | No                                                                                           |
| 6   | New portfolio starts with            | `seedDefaults`, or optionally copy categories + receipt rules from a portfolio you belong to |
| 7   | Invites                              | One-time link copied by the admin, valid 7 days; email later if SMTP is added                |
| 8   | Removing a member                    | Access ends at once, their keys for it are revoked, history keeps their name                 |
| 9   | Deleting a portfolio                 | Instance admin only, typed confirmation, backup first; archive may be enough                 |
| 10  | Moving a property between portfolios | Not now (needs category mapping)                                                             |
| 11  | Totals across portfolios             | No                                                                                           |
| 12  | Portfolio in the URL                 | Always: `/<portfolio>/<property>/…` (readable slugs); API calls carry `?portfolio=<slug>`    |
| 13  | OIDC login with no invite            | "Not in a portfolio yet" page                                                                |
| 14  | Tax / location settings              | On the property                                                                              |
| 15  | Existing data                        | Portfolio 1; the existing user is its admin and instance admin                               |

Backups stay instance-wide (instance admin). A per-portfolio "download my data" can reuse the preparer zip and CSV
exports; restoring a single portfolio is out of scope.

## Status: all phases built

1. **Data model and scoping.** `portfolio_id` columns, per-portfolio uniques, composite foreign keys, backfill into
   portfolio 1 (one migration, `0017_portfolios`, which also adds memberships, invites and slugs); `currentPortfolioId()`, `propertyScope`, scoped lookups; canary test.
2. **Memberships and roles.** The request's role is the membership's (`resolveActor`); `requireAdmin` = portfolio
   admin, `requireInstanceAdmin` = server-wide (portfolios, logins, backups). A portfolio admin changes only roles
   and membership in their own portfolio; password/disabled/name are the instance admin's (or your own password).
   The instance admin opens other portfolios read-only, audited there once a day. Last-admin guard.
3. **Portfolio in the URL.** `/<portfolio slug>/<property slug>/…` (e.g. `/alexs-portfolio/harbor-view/occupancy`) via
   React Router's basename; API calls carry `?portfolio=<slug>` (rather than an `/api/<slug>` prefix: same
   isolation, and the service worker's cache keys and the outbox's stored requests stay per portfolio without
   touching every route). Slugs are readable, from the name (`server/slugs.ts`), kept on rename and editable;
   portfolio slugs never take a reserved first segment (server routes, built files, app pages). A slug is no secret: every
   request checks membership. Old links (`/transactions`, `/p/<id>/…`) redirect.
4. **Admin screens.** Settings is grouped by whom a page affects, and the UI says "portfolio" (shown even to someone
   with just one): Your account (Account, Preferences); Portfolio (General: name, web address, leave; Properties;
   Categories; Who has access: members, roles, invites; API keys & agents; Change history; Download everything);
   Server, instance admin only (All portfolios: create from defaults or a copy, admin invite link, archive; Logins:
   add one with a password into a chosen portfolio, set password, disable; Backup & restore; Server activity). Deleting a portfolio is left out:
   archiving hides it and stops its keys, and a backup has everything. CLI `--portfolio`; the harness seeds a second
   portfolio.
5. **Invites.** One-time links (hashed, 7 days, revocable); join signed in with your login, by making a login, or
   with SSO (even without `OIDC_AUTO_CREATE`). Uninvited SSO logins see "not in a portfolio yet".

Follow-ups done: "Download everything" (a per-portfolio zip for its own people), plain-word Change history entries
for access, a clear "no access" answer instead of a server error when access is lost, one picker for properties and
other portfolios, leaving a portfolio yourself, the portfolio's name in MCP `get_overview`, and `users.role` no longer read or written.

Work saved offline is queued under the portfolio's id, not its web address, so it still replays after the address
changes; work queued before there were several portfolios replays into the first one (where migration 0017 put
everything).

Known limits: entries about a login itself (sign-ins, password changes, "created") have no portfolio and show in the
audit log of every portfolio the person belongs to. Per-portfolio restore and moving a property between portfolios
are out of scope (decisions above).
