/**
 * Database schema. Change tables here, then run `vp run db:generate` to create a migration in
 * server/db/migrations. Migrations are applied automatically on startup.
 */
import { sql } from "drizzle-orm";
import { blob, check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const createdAt = () => text("created_at").notNull().default(now);

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    passwordHash: text("password_hash"),
    role: text("role", { enum: ["admin", "member", "viewer"] })
      .notNull()
      .default("member"),
    oidcSub: text("oidc_sub").unique(),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(sql`lower(${t.email})`),
    check("users_role_check", sql`${t.role} IN ('admin','member','viewer')`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    /** sha256 of the session token */
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: integer("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    /** sha256 of the full key */
    keyHash: text("key_hash").notNull().unique(),
    scope: text("scope", { enum: ["read", "write"] }).notNull(),
    createdAt: createdAt(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [check("api_keys_scope_check", sql`${t.scope} IN ('read','write')`)],
);

export const properties = sqliteTable(
  "properties",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    address: text("address").notNull().default(""),
    /** YYYY-MM-DD */
    placedInService: text("placed_in_service"),
    /** Depreciable basis, excluding land */
    buildingBasisCents: integer("building_basis_cents"),
    recoveryYears: real("recovery_years").notNull().default(27.5),
    notes: text("notes").notNull().default(""),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("properties_name_unique").on(sql`lower(${t.name})`)],
);

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["income", "expense"] }).notNull(),
    defaultAllocation: text("default_allocation", { enum: ["direct", "indirect"] }),
    scheduleELine: text("schedule_e_line"),
    description: text("description").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    /**
     * When an expense in this category should have a receipt: 'always' (any amount), 'threshold' (at least
     * receiptMinCents, or the app default) or 'never'. Decided in services/receipts.ts. Validated by zod, not a
     * CHECK, so adding it didn't rebuild the table.
     */
    receiptPolicy: text("receipt_policy", { enum: ["always", "threshold", "never"] })
      .notNull()
      .default("threshold"),
    /** Threshold override for 'threshold'; null = the app default (RECEIPT_MIN_DOLLARS) */
    receiptMinCents: integer("receipt_min_cents"),
  },
  (t) => [
    uniqueIndex("categories_name_unique").on(sql`lower(${t.name})`),
    check("categories_kind_check", sql`${t.kind} IN ('income','expense')`),
    check("categories_allocation_check", sql`${t.defaultAllocation} IN ('direct','indirect')`),
  ],
);

/**
 * Saved subcategories, so they can be offered before first use. Transactions store the subcategory as text;
 * rename/remove in services/categories.ts keep both in step.
 */
export const subcategories = sqliteTable(
  "subcategories",
  {
    id: integer("id").primaryKey(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
    /** Receipt rule for entries in this subcategory; null = same as the category (services/receipts.ts) */
    receiptPolicy: text("receipt_policy", { enum: ["always", "threshold", "never"] }),
    /** Threshold for 'threshold'; null = the category's, then the app default */
    receiptMinCents: integer("receipt_min_cents"),
  },
  (t) => [uniqueIndex("subcategories_category_name").on(t.categoryId, t.name)],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id),
    /** Cash-basis date paid/received, YYYY-MM-DD */
    date: text("date").notNull(),
    /** Signed: income positive, expenses negative */
    amountCents: integer("amount_cents").notNull(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id),
    subcategory: text("subcategory").notNull().default(""),
    vendor: text("vendor").notNull().default(""),
    allocation: text("allocation", { enum: ["direct", "indirect"] }),
    description: text("description").notNull().default(""),
    account: text("account").notNull().default(""),
    reference: text("reference").notNull().default(""),
    needsReview: integer("needs_review", { mode: "boolean" }).notNull().default(false),
    reviewNote: text("review_note").notNull().default(""),
    source: text("source").notNull().default("web"),
    externalId: text("external_id").unique(),
    /** Random id the app generates when an entry is saved (offline outbox); a replay returns the existing row. */
    clientId: text("client_id").unique(),
    createdAt: createdAt(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: text("updated_at").notNull().default(now),
    updatedBy: integer("updated_by").references(() => users.id),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    check("transactions_date_check", sql`${t.date} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'`),
    check("transactions_allocation_check", sql`${t.allocation} IN ('direct','indirect')`),
    index("tx_date")
      .on(t.date)
      .where(sql`${t.deletedAt} IS NULL`),
    index("tx_property_date").on(t.propertyId, t.date),
    index("tx_category").on(t.categoryId),
    index("tx_review")
      .on(t.needsReview)
      .where(sql`${t.needsReview} = 1 AND ${t.deletedAt} IS NULL`),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: integer("id").primaryKey(),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    /** Identical files share one stored file, so several rows can point at the same key. */
    storageKey: text("storage_key").notNull(),
    createdAt: createdAt(),
    createdBy: integer("created_by").references(() => users.id),
  },
  (t) => [
    index("attachments_tx").on(t.transactionId),
    index("attachments_sha").on(t.sha256),
    index("attachments_key").on(t.storageKey),
  ],
);

/**
 * Receipts uploaded from the entry form before the entry is saved. Saving the entry (`upload_ids`) turns them into
 * attachments; the form discards them if it's closed without saving, and stale ones are pruned. The stored file may be
 * shared with attachments or manager documents (same sha256).
 */
export const pendingUploads = sqliteTable(
  "pending_uploads",
  {
    id: integer("id").primaryKey(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: createdAt(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("pending_uploads_key").on(t.storageKey), index("pending_uploads_sha").on(t.sha256)],
);

/**
 * A small JPEG picture of a stored file that isn't an image itself (a scanned PDF's first page, made by the scanner on
 * the phone), keyed by the file's sha256 so every row sharing the file shares it. Removed with the file's last
 * reference (`dropOrphanPreviews` in `server/services/storage.ts`).
 */
export const filePreviews = sqliteTable("file_previews", {
  sha256: text("sha256").primaryKey(),
  data: blob("data", { mode: "buffer" }).notNull(),
  createdAt: createdAt(),
});

/**
 * Property-manager paperwork saved for re-checking later: owner-statement CSVs and invoices, one row per file.
 * `text` keeps the CSV / extracted invoice text so it's re-parsed on every review (parser fixes apply to old months).
 * Files live in the uploads folder and may share a stored file with attachments (same sha256).
 */
export const managerDocuments = sqliteTable(
  "manager_documents",
  {
    id: integer("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id),
    /** Service month, YYYY-MM */
    month: text("month").notNull(),
    kind: text("kind", { enum: ["statement", "invoice"] }).notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    text: text("text").notNull(),
    /** Invoice number, for invoices */
    reference: text("reference").notNull().default(""),
    createdAt: createdAt(),
    createdBy: integer("created_by").references(() => users.id),
  },
  (t) => [
    index("manager_documents_month").on(t.propertyId, t.month),
    uniqueIndex("manager_documents_sha").on(t.propertyId, t.sha256),
    check("manager_documents_kind_check", sql`${t.kind} IN ('statement','invoice')`),
    check("manager_documents_month_check", sql`${t.month} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`),
  ],
);

/** "Explained" notes on manager-statement checks, so a known difference stops being reported as a to-do. */
export const managerAcknowledgements = sqliteTable(
  "manager_acknowledgements",
  {
    id: integer("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id),
    month: text("month").notNull(),
    /** Check.key from services/manager-statement.ts */
    checkKey: text("check_key").notNull(),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    createdBy: integer("created_by").references(() => users.id),
  },
  (t) => [uniqueIndex("manager_acknowledgements_unique").on(t.propertyId, t.month, t.checkKey)],
);

export const occupancy = sqliteTable(
  "occupancy",
  {
    id: integer("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id),
    /** YYYY-MM */
    month: text("month").notNull(),
    nightsAvailable: integer("nights_available"),
    nightsBooked: integer("nights_booked").notNull().default(0),
    ownerNights: integer("owner_nights").notNull().default(0),
    checkIns: integer("check_ins").notNull().default(0),
    notes: text("notes").notNull().default(""),
  },
  (t) => [
    uniqueIndex("occupancy_property_month").on(t.propertyId, t.month),
    check("occupancy_month_check", sql`${t.month} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`),
  ],
);

/**
 * Personal-use stays (owner, family, below-market rent), by date. end_date is the checkout day (exclusive), like
 * calendar_events: Mar 3 → Mar 6 is 3 nights. Stays of one property never overlap (enforced in
 * services/owner-stays.ts). For any month a stay has a night in, owner_nights is derived from the stays and the
 * stored occupancy.owner_nights is ignored (kept, so it comes back when the stays are removed).
 */
export const ownerStays = sqliteTable(
  "owner_stays",
  {
    id: integer("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    /** owner | family | below_market; all count as personal days. null = not said */
    kind: text("kind", { enum: ["owner", "family", "below_market"] }),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    index("owner_stays_property_dates").on(t.propertyId, t.startDate),
    check("owner_stays_dates_check", sql`${t.endDate} > ${t.startDate}`),
    check("owner_stays_kind_check", sql`${t.kind} IS NULL OR ${t.kind} IN ('owner','family','below_market')`),
  ],
);

/** Blocked calendar ranges the user said were not an owner stay ("Not a stay"), so they aren't suggested again. */
export const ownerStayDismissals = sqliteTable(
  "owner_stay_dismissals",
  {
    id: integer("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    createdAt: createdAt(),
    createdBy: integer("created_by").references(() => users.id),
  },
  (t) => [uniqueIndex("owner_stay_dismissals_unique").on(t.propertyId, t.startDate, t.endDate)],
);

/**
 * "Keep mine" on a month whose calendar guest nights differ from the saved occupancy. Remembers both sides' numbers:
 * the month is asked about again as soon as the calendar or the saved row changes.
 */
export const occupancyCalendarKeeps = sqliteTable(
  "occupancy_calendar_keeps",
  {
    id: integer("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id),
    month: text("month").notNull(),
    calendarNights: integer("calendar_nights").notNull(),
    calendarCheckIns: integer("calendar_check_ins").notNull(),
    /** null when nothing was saved for the month */
    storedNights: integer("stored_nights"),
    storedCheckIns: integer("stored_check_ins"),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    createdBy: integer("created_by").references(() => users.id),
  },
  (t) => [uniqueIndex("occupancy_calendar_keeps_unique").on(t.propertyId, t.month)],
);

export const taxYears = sqliteTable(
  "tax_years",
  {
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id),
    year: integer("year").notNull(),
    /** From Form 1098 */
    mortgageInterestCents: integer("mortgage_interest_cents"),
    rentalDaysOverride: integer("rental_days_override"),
    personalDaysOverride: integer("personal_days_override"),
    notes: text("notes").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.propertyId, t.year] })],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey(),
    at: text("at").notNull().default(now),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    apiKeyId: integer("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    /** web | api | mcp | cli */
    via: text("via").notNull(),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: integer("entity_id"),
    /** JSON */
    changes: text("changes", { mode: "json" }),
  },
  (t) => [index("audit_entity").on(t.entity, t.entityId)],
);

/**
 * User feedback on recurring-expense detection. A row with month = '' stops tracking the whole series;
 * a row with a month (YYYY-MM) says "nothing was due / it's fine" for that one month.
 */
export const recurringDismissals = sqliteTable(
  "recurring_dismissals",
  {
    id: integer("id").primaryKey(),
    /** property:category:vendor:subcategory, see services/recurring.ts */
    seriesKey: text("series_key").notNull(),
    month: text("month").notNull().default(""),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    createdBy: integer("created_by").references(() => users.id),
  },
  (t) => [uniqueIndex("recurring_dismissals_unique").on(t.seriesKey, t.month)],
);

/**
 * Vendors that never need a receipt (e.g. Airbnb, Stripe), whatever the category or subcategory. Matched
 * case-insensitively against a transaction's vendor. Subcategories have their own rule on `subcategories`.
 */
export const receiptExclusions = sqliteTable(
  "receipt_exclusions",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    createdBy: integer("created_by").references(() => users.id),
  },
  (t) => [uniqueIndex("receipt_exclusions_name").on(sql`lower(${t.name})`)],
);

/**
 * Saved CSV column mappings, one per bank/card/provider export layout. `headers` is the file's header row (JSON
 * array) so a new upload with the same columns picks its profile automatically; `mapping` is the JSON ImportMapping
 * from services/csv-import.ts, with columns referenced by header name.
 */
export const importProfiles = sqliteTable(
  "import_profiles",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    headers: text("headers").notNull().default("[]"),
    mapping: text("mapping").notNull(),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("import_profiles_name").on(sql`lower(${t.name})`)],
);

/**
 * Booking calendars to import (Airbnb/VRBO iCal export links). url is null for a feed filled by uploading an
 * .ics file. The url carries a secret token, so it is never logged or shown to read-only users.
 */
export const calendarFeeds = sqliteTable("calendar_feeds", {
  id: integer("id").primaryKey(),
  propertyId: integer("property_id")
    .notNull()
    .references(() => properties.id),
  name: text("name").notNull(),
  url: text("url"),
  lastSyncedAt: text("last_synced_at"),
  lastError: text("last_error"),
  createdAt: createdAt(),
});

/**
 * Booking calendar events: reservations and blocked dates.
 * - source 'feed': imported from a calendar feed (feed_id set). Every sync upserts them by uid; missing ones that
 *   haven't ended are deleted (cancelled), past ones are kept.
 * - source 'history': past stays imported from a reservations export (Airbnb "Export to CSV"), feed_id null and
 *   uid = the confirmation code. Syncs never touch them; they are removed only per property.
 * Dates are YYYY-MM-DD; end_date is the checkout day (exclusive).
 */
export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: integer("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id),
    feedId: integer("feed_id").references(() => calendarFeeds.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["feed", "history"] })
      .notNull()
      .default("feed"),
    uid: text("uid").notNull(),
    kind: text("kind", { enum: ["reserved", "blocked"] }).notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    summary: text("summary").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("calendar_events_feed_uid").on(t.feedId, t.uid),
    uniqueIndex("calendar_events_history_uid")
      .on(t.propertyId, t.uid)
      .where(sql`${t.feedId} IS NULL`),
    index("calendar_events_property_dates").on(t.propertyId, t.startDate),
    check("calendar_events_kind_check", sql`${t.kind} IN ('reserved','blocked')`),
    check("calendar_events_source_check", sql`${t.source} IN ('feed','history')`),
    check("calendar_events_source_feed_check", sql`(${t.source} = 'feed') = (${t.feedId} IS NOT NULL)`),
    check("calendar_events_dates_check", sql`${t.endDate} > ${t.startDate}`),
  ],
);
