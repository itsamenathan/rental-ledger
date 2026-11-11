CREATE TABLE `recurring_dismissals` (
	`id` integer PRIMARY KEY NOT NULL,
	`series_key` text NOT NULL,
	`month` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_dismissals_unique` ON `recurring_dismissals` (`series_key`,`month`);