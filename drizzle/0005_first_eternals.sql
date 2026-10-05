CREATE TABLE `external_shared_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`operation` text NOT NULL,
	`phase` text NOT NULL,
	`provider_action` text,
	`provider_id` text,
	`target_fingerprint` text,
	`deadline_at` integer,
	`dispatched_at` integer,
	`reconciled_at` integer,
	`state` text NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_shared_operation_domain` ON `external_shared_operation` (`org_id`,`state`);--> statement-breakpoint
CREATE TABLE `external_shared_reference` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_shared_reference_owner` ON `external_shared_reference` (`org_id`,`user_id`,`created_at`);