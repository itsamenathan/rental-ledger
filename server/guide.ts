export const API_GUIDE = `# Rental Ledger API

Bookkeeping for short-term rental properties: income, expenses (direct vs indirect), occupancy, receipts,
and year-end tax reports.

## Authentication

Create an API key in the web app under **Settings → API keys**. Send it as a Bearer token:

    Authorization: Bearer rk_xxxxxxxx_...

Keys are per user and are either \`read\` or \`write\`. Every change is recorded in the audit log with the
user, key name, and channel (web / api / mcp).

## MCP (recommended for AI agents)

Streamable HTTP MCP endpoint: \`POST /mcp\` with the same Bearer key. Example client config:

    {
      "mcpServers": {
        "rental": {
          "type": "http",
          "url": "https://YOUR-HOST/mcp",
          "headers": { "Authorization": "Bearer rk_..." }
        }
      }
    }

Tools: get_overview, list_categories, search_transactions, get_transaction, add_expense, add_transaction,
bulk_add_transactions, update_transaction, bulk_update_transactions, delete_transaction, flag_for_review,
attach_receipt, list_files, link_attachment, unlink_attachment, update_attachment, get_summary, get_tax_report, list_occupancy, set_occupancy, set_tax_year_inputs,
list_owner_stays, add_owner_stay, update_owner_stay, delete_owner_stay, list_owner_stay_candidates,
dismiss_owner_stay_candidate, compare_occupancy_calendar, apply_calendar_to_occupancy,
get_calendar, list_calendar_feeds, add_calendar_feed, refresh_calendar_feeds,
add_category, update_category, delete_category, add_subcategory, rename_subcategory,
remove_subcategory, set_subcategory_receipt_rule, list_receipt_exclusions, add_receipt_exclusion, remove_receipt_exclusion,
month_summary, category_by_month, year_totals, get_todo, get_recurring, dismiss_recurring, recent_changes, undo_change.

## Data model

- **amount** is signed dollars: income positive, expenses negative. Creating an expense with a positive
  amount is rejected unless \`refund: true\` (money returned to you on an expense category).
- **category** — name or id. Each category has a \`kind\` (income/expense), a default **allocation**, and a
  Schedule E line.
- **allocation** — \`direct\` (only for the rental activity: cleaning, commissions, management fees, guest
  supplies) or \`indirect\` (whole property: mortgage, insurance, property tax, utilities shared with personal
  use). Indirect expenses are prorated by rental-use % in the tax report.
- **vendor** — payee for expenses, payer for income (Airbnb, VRBO, …). Used for 1099-K reconciliation.
- **reference / external_id** — source identifiers used for duplicate detection.
- **client_id** — optional idempotency key for a single create: retrying with the same client_id returns the entry
  already saved instead of adding another (the app's offline outbox uses it).
- **needs_review / review_note** — flag anything uncertain for a human.
- **receipts** — an expense "needs a receipt" by its subcategory's rule if it has one, else its category's
  \`receipt_policy\` (\`always\`, \`threshold\`: at least \`receipt_min\` dollars, default $75, or \`never\`, e.g.
  mortgage), unless its vendor is on the never-ask list (list_receipt_exclusions). To do, Files, the tax report and
  \`needs_receipt=true\` share this rule.
- **property** — name or id. See "Picking a property" below.

## Picking a property

Each rental property is its own set of books: transactions, occupancy, booking calendars, tax-year inputs and
manager paperwork belong to one property. Users, API keys, categories, receipt rules and import profiles are shared.

- \`GET /api/properties\` (or \`/api/overview\`) lists them. Pass \`property_id=<id>\` (or \`property=<name>\`) in the
  query string, or \`property\` / \`property_id\` in a JSON body.
- While there is only one active property it may be left out. With several, leaving it out is a 400 error rather
  than a guess.
- Reads that total things up (transactions, files, occupancy, calendar feeds, reports/summary, reports/month,
  reports/years, reports/categories, todo, recurring) also take \`property=all\` to add up every property. The tax
  report, tax package, calendar, tax years and manager paperwork are always for one property.
- In the web app the property is in the URL: \`/p/<id>/transactions\`, and \`/p/all/\` for the totals view.

## REST endpoints (JSON)

    GET    /api/overview                       properties, categories, years
    GET    /api/transactions?property_id=&year=&month=YYYY-MM&from=&to=&category=&kind=&allocation=direct|indirect|none
                         &vendor=&q=&amount=69.95|50-100|>500|~70&needs_review=true&has_attachment=false
                         &sort=date_desc&limit=100&offset=0
    POST   /api/transactions                   one object, or an array (bulk)
    POST   /api/transactions/bulk              {transactions:[...], dry_run, skip_duplicates, needs_review}
    POST   /api/transactions/bulk-update       {ids:[...], patch:{...}}
    POST   /api/transactions/bulk-delete       {ids:[...]}
    GET    /api/transactions/:id               includes attachments
    PATCH  /api/transactions/:id
    DELETE /api/transactions/:id               soft delete; POST /api/transactions/:id/restore to undo
    POST   /api/transactions/:id/attachments   multipart/form-data, field "file"
    GET    /api/attachments/:id                download
    GET    /api/suggestions                    vendors with last-used category, subcategories, accounts
    GET    /api/categories | POST | PATCH /:id | DELETE /:id {move_to?} (moves its transactions first)
    GET    /api/subcategories                  saved + used subcategories with counts; POST {category, name}
    POST   /api/subcategories/rename           {category, from, to}  updates every transaction; merges if "to" exists
    POST   /api/subcategories/remove           {category, name, move_to?}
    POST   /api/subcategories/receipt-rule     {category, name, receipt_policy: always|threshold|never|inherit, receipt_min?}
    GET    /api/receipt-exclusions             vendors that never need a receipt; POST {name, note?}; DELETE /:id
    GET    /api/properties | POST | PATCH /:id
    GET    /api/occupancy?year=                PUT /api/occupancy {month, nights_booked, owner_nights, check_ins}
                                               owner_nights is ignored for months with owner stays (derived from them)
    GET    /api/occupancy/calendar?year=       calendar vs saved guest nights per month (ended months with calendar data)
    POST   /api/occupancy/calendar/apply       {months: [YYYY-MM], confirm_lower?} copy calendar nights/check-ins
    GET    /api/owner-stays?year= | POST {start_date, end_date (checkout), kind?, note?} | PATCH /:id | DELETE /:id
    GET    /api/owner-stays/candidates?year=   blocked calendar ranges that may be owner stays
    POST   /api/owner-stays/dismissals         {start_date, end_date} "not a stay"; DELETE /:id suggests it again
    GET    /api/calendar?from=YYYY-MM&to=      imported reservations/blocks, which holds each night, booked/blocked/free per month
    GET    /api/calendar/feeds | POST {name, url?} | PATCH /:id | DELETE /:id (removes its events)
    POST   /api/calendar/feeds/:id/refresh     download the iCal link now; /import takes .ics text as the body
    POST   /api/calendar/refresh               {stale_minutes?} refresh every linked feed
    GET    /api/tax-years/:year                PUT {mortgage_interest, rental_days_override, personal_days_override}
    GET    /api/reports/summary?year=
    GET    /api/reports/month?month=YYYY-MM    month totals vs last month/last year/12-mo avg, per category, bill checklist
    GET    /api/reports/years                  totals per year
    GET    /api/reports/categories?year=       category (+ subcategory) × month grid
    GET    /api/todo                           to-do counts (flagged, unallocated, recurring alerts, missing receipts)
    GET    /api/recurring                      learned recurring bills + alerts (missing, duplicate, amount changed)
    POST   /api/recurring/dismissals           {series_key, month?} "fine this month" / stop tracking; DELETE /:id undoes
    GET    /api/reports/tax-package.zip?year=  for the tax preparer: Summary.txt, tax CSV, transactions CSV, receipts
    GET    /api/reports/tax?year=              JSON; /api/reports/tax.csv for CSV
    GET    /api/export/transactions.csv?year=
    GET    /api/audit?entity=transaction&entity_id=   each entry has "undo" (what undo does) and "undone"
    POST   /api/audit/:id/undo                reverse one change

Errors return \`{"error": "message"}\` with an HTTP status.

## Example: add an expense

    curl -X POST https://YOUR-HOST/api/transactions \\
      -H "Authorization: Bearer rk_..." -H "Content-Type: application/json" \\
      -d '{"date":"2026-11-10","amount":-142.50,"category":"Supplies","vendor":"Costco","description":"Paper towels, coffee"}'
`;
