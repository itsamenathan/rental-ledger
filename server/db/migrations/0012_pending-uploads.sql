CREATE TABLE `pending_uploads` (
	`id` integer PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_uploads_key` ON `pending_uploads` (`storage_key`);--> statement-breakpoint
CREATE INDEX `pending_uploads_sha` ON `pending_uploads` (`sha256`);