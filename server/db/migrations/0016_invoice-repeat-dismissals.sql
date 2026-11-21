CREATE TABLE `invoice_repeat_dismissals` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`phrase` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_repeat_dismissals_unique` ON `invoice_repeat_dismissals` (`property_id`,`phrase`);