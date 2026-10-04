ALTER TABLE `external_memory_operation` ADD `operation` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `external_memory_operation` ADD `phase` text DEFAULT 'dispatched' NOT NULL;--> statement-breakpoint
ALTER TABLE `external_memory_operation` ADD `provider_action` text;--> statement-breakpoint
ALTER TABLE `external_memory_operation` ADD `provider_id` text;--> statement-breakpoint
ALTER TABLE `external_memory_operation` ADD `target_fingerprint` text;--> statement-breakpoint
ALTER TABLE `external_memory_operation` ADD `deadline_at` integer;--> statement-breakpoint
ALTER TABLE `external_memory_operation` ADD `dispatched_at` integer;--> statement-breakpoint
ALTER TABLE `external_memory_operation` ADD `reconciled_at` integer;