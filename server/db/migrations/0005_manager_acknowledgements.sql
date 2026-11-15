CREATE TABLE `manager_acknowledgements` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`month` text NOT NULL,
	`check_key` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manager_acknowledgements_unique` ON `manager_acknowledgements` (`property_id`,`month`,`check_key`);