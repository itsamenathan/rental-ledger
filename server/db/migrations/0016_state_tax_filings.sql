CREATE TABLE `state_tax_filings` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`year` integer NOT NULL,
	`quarter` integer NOT NULL,
	`gross_filed_cents` integer,
	`amount_paid_cents` integer NOT NULL,
	`paid_date` text NOT NULL,
	`confirmation` text DEFAULT '' NOT NULL,
	`transaction_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_by` integer,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "state_tax_filings_quarter_check" CHECK("state_tax_filings"."quarter" BETWEEN 1 AND 4)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `state_tax_filings_quarter` ON `state_tax_filings` (`property_id`,`year`,`quarter`);--> statement-breakpoint
CREATE UNIQUE INDEX `state_tax_filings_tx` ON `state_tax_filings` (`transaction_id`) WHERE "state_tax_filings"."transaction_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `properties` ADD `state_tax_location_id` text DEFAULT '' NOT NULL;