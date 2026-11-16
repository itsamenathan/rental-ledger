CREATE TABLE `calendar_events` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`feed_id` integer NOT NULL,
	`uid` text NOT NULL,
	`kind` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`feed_id`) REFERENCES `calendar_feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "calendar_events_kind_check" CHECK("calendar_events"."kind" IN ('reserved','blocked')),
	CONSTRAINT "calendar_events_dates_check" CHECK("calendar_events"."end_date" > "calendar_events"."start_date")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_feed_uid` ON `calendar_events` (`feed_id`,`uid`);--> statement-breakpoint
CREATE INDEX `calendar_events_property_dates` ON `calendar_events` (`property_id`,`start_date`);--> statement-breakpoint
CREATE TABLE `calendar_feeds` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`last_synced_at` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
