DROP INDEX `attachments_storage_key_unique`;--> statement-breakpoint
CREATE INDEX `attachments_sha` ON `attachments` (`sha256`);--> statement-breakpoint
CREATE INDEX `attachments_key` ON `attachments` (`storage_key`);