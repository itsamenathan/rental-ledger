CREATE TABLE `import_profiles` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`headers` text DEFAULT '[]' NOT NULL,
	`mapping` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_profiles_name` ON `import_profiles` (lower("name"));