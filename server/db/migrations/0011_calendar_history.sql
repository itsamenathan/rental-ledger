PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_calendar_events` (
	`id` integer PRIMARY KEY NOT NULL,
	`property_id` integer NOT NULL,
	`feed_id` integer,
	`source` text DEFAULT 'feed' NOT NULL,
	`uid` text NOT NULL,
	`kind` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`feed_id`) REFERENCES `calendar_feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "calendar_events_kind_check" CHECK("__new_calendar_events"."kind" IN ('reserved','blocked')),
	CONSTRAINT "calendar_events_source_check" CHECK("__new_calendar_events"."source" IN ('feed','history')),
	CONSTRAINT "calendar_events_source_feed_check" CHECK(("__new_calendar_events"."source" = 'feed') = ("__new_calendar_events"."feed_id" IS NOT NULL)),
	CONSTRAINT "calendar_events_dates_check" CHECK("__new_calendar_events"."end_date" > "__new_calendar_events"."start_date")
);
--> statement-breakpoint
INSERT INTO `__new_calendar_events`("id", "property_id", "feed_id", "source", "uid", "kind", "start_date", "end_date", "summary", "created_at", "updated_at") SELECT "id", "property_id", "feed_id", 'feed', "uid", "kind", "start_date", "end_date", "summary", "created_at", "updated_at" FROM `calendar_events`;--> statement-breakpoint
DROP TABLE `calendar_events`;--> statement-breakpoint
ALTER TABLE `__new_calendar_events` RENAME TO `calendar_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_feed_uid` ON `calendar_events` (`feed_id`,`uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_history_uid` ON `calendar_events` (`property_id`,`uid`) WHERE "calendar_events"."feed_id" IS NULL;--> statement-breakpoint
CREATE INDEX `calendar_events_property_dates` ON `calendar_events` (`property_id`,`start_date`);