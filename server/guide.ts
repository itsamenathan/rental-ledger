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
attach_receipt, get_summary, get_tax_report, list_occupancy, set_occupancy, set_tax_year_inputs,
add_category, update_category, delete_category, add_subcategory, rename_subcategory,
remove_subcategory, month_summary, category_by_month, year_totals, get_todo, get_recurring, dismiss_recurring, recent_changes, undo_change.

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
- **needs_review / review_note** — flag anything uncertain for a human.
- **property** — name or id; may be omitted when only one property exists.

## REST endpoints (JSON)

    GET    /api/overview                       properties, categories, years
    GET    /api/transactions?year=&month=YYYY-MM&from=&to=&category=&kind=&allocation=direct|indirect|none
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
    GET    /api/properties | POST | PATCH /:id
    GET    /api/occupancy?year=                PUT /api/occupancy {month, nights_booked, owner_nights, check_ins}
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
