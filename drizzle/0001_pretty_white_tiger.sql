CREATE TABLE `external_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`member_id` text NOT NULL,
	`label` text NOT NULL,
	`secret_hash` text NOT NULL,
	`grants` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_credential_org` ON `external_credential` (`org_id`);--> statement-breakpoint
CREATE TABLE `external_quota` (
	`key` text PRIMARY KEY NOT NULL,
	`credential_id` text NOT NULL,
	`window` integer NOT NULL,
	`count` integer NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `external_credential`(`id`) ON UPDATE no action ON DELETE cascade
);
