CREATE TABLE `assistant_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`status` text NOT NULL,
	`user_message_id` text,
	`assistant_message_id` text,
	`error_text` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_assistant_runs_session_request` ON `assistant_runs` (`session_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_runs_session_created` ON `assistant_runs` (`session_id`,`created_at`);