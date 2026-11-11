CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "api_keys_scope_check" CHECK("api_keys"."scope" IN ('read','write'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY NOT NULL,
	`transaction_id` integer NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_storage_key_unique` ON `attachments` (`storage_key`);--> statement-breakpoint
CREATE INDEX `attachments_tx` ON `attachments` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`user_id` integer,
	`api_key_id` integer,
	`via` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` integer,
	`changes` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_entity` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`default_allocation` text,
	`schedule_e_line` text,
	`description` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	CONSTRAINT "categories_kind_check" CHECK("categories"."kind" IN ('income','expense')),
	CONSTRAINT "categories_allocation_check" CHECK("categories"."default_allocation" IN ('direct','indirect'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (lower("name"));--> statement-breakpoint
CREATE TABLE `occupancy` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`month` text NOT NULL,
	`nights_available` integer,
	`nights_booked` integer DEFAULT 0 NOT NULL,
	`owner_nights` integer DEFAULT 0 NOT NULL,
	`check_ins` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "occupancy_month_check" CHECK("occupancy"."month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `occupancy_property_month` ON `occupancy` (`property_id`,`month`);--> statement-breakpoint
CREATE TABLE `properties` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`placed_in_service` text,
	`building_basis_cents` integer,
	`recovery_years` real DEFAULT 27.5 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `properties_name_unique` ON `properties` (lower("name"));--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `tax_years` (
	`property_id` integer NOT NULL,
	`year` integer NOT NULL,
	`mortgage_interest_cents` integer,
	`rental_days_override` integer,
	`personal_days_override` integer,
	`notes` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`property_id`, `year`),
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`category_id` integer NOT NULL,
	`subcategory` text DEFAULT '' NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`allocation` text,
	`description` text DEFAULT '' NOT NULL,
	`account` text DEFAULT '' NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`needs_review` integer DEFAULT false NOT NULL,
	`review_note` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'web' NOT NULL,
	`external_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_by` integer,
	`deleted_at` text,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_date_check" CHECK("transactions"."date" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
	CONSTRAINT "transactions_allocation_check" CHECK("transactions"."allocation" IN ('direct','indirect'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_external_id_unique` ON `transactions` (`external_id`);--> statement-breakpoint
CREATE INDEX `tx_date` ON `transactions` (`date`) WHERE "transactions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `tx_property_date` ON `transactions` (`property_id`,`date`);--> statement-breakpoint
CREATE INDEX `tx_category` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `tx_review` ON `transactions` (`needs_review`) WHERE "transactions"."needs_review" = 1 AND "transactions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`password_hash` text,
	`role` text DEFAULT 'member' NOT NULL,
	`oidc_sub` text,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "users_role_check" CHECK("users"."role" IN ('admin','member','viewer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidc_sub_unique` ON `users` (`oidc_sub`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (lower("email"));