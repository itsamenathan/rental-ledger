ALTER TABLE `transactions` ADD `client_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_client_id_unique` ON `transactions` (`client_id`);