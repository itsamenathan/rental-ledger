CREATE TABLE `occupancy_calendar_keeps` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`month` text NOT NULL,
	`calendar_nights` integer NOT NULL,
	`calendar_check_ins` integer NOT NULL,
	`stored_nights` integer,
	`stored_check_ins` integer,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `occupancy_calendar_keeps_unique` ON `occupancy_calendar_keeps` (`property_id`,`month`);