CREATE TABLE `manager_documents` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`month` text NOT NULL,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`text` text NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` integer,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "manager_documents_kind_check" CHECK("manager_documents"."kind" IN ('statement','invoice')),
	CONSTRAINT "manager_documents_month_check" CHECK("manager_documents"."month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]')
);
--> statement-breakpoint
CREATE INDEX `manager_documents_month` ON `manager_documents` (`property_id`,`month`);--> statement-breakpoint
CREATE UNIQUE INDEX `manager_documents_sha` ON `manager_documents` (`property_id`,`sha256`);