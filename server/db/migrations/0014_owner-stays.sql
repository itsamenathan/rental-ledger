CREATE TABLE `owner_stay_dismissals` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owner_stay_dismissals_unique` ON `owner_stay_dismissals` (`property_id`,`start_date`,`end_date`);--> statement-breakpoint
CREATE TABLE `owner_stays` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`kind` text,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "owner_stays_dates_check" CHECK("owner_stays"."end_date" > "owner_stays"."start_date"),
	CONSTRAINT "owner_stays_kind_check" CHECK("owner_stays"."kind" IS NULL OR "owner_stays"."kind" IN ('owner','family','below_market'))
);
--> statement-breakpoint
CREATE INDEX `owner_stays_property_dates` ON `owner_stays` (`property_id`,`start_date`);