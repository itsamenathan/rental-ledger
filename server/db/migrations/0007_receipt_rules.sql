CREATE TABLE `receipt_exclusions` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_exclusions_name` ON `receipt_exclusions` (lower("name"));--> statement-breakpoint
ALTER TABLE `categories` ADD `receipt_policy` text DEFAULT 'threshold' NOT NULL;--> statement-breakpoint
ALTER TABLE `categories` ADD `receipt_min_cents` integer;--> statement-breakpoint
ALTER TABLE `subcategories` ADD `receipt_policy` text;--> statement-breakpoint
ALTER TABLE `subcategories` ADD `receipt_min_cents` integer;