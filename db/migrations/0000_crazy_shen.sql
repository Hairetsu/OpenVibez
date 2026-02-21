CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `background_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`payload_json` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_state_kind` ON `background_jobs` (`state`,`kind`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`content_format` text DEFAULT 'markdown' NOT NULL,
	`tool_name` text,
	`tool_call_id` text,
	`seq` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_microunits` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_messages_session_seq` ON `messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_messages_session_created` ON `messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `model_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`label` text NOT NULL,
	`temperature` real,
	`top_p` real,
	`max_output_tokens` integer,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_model_profiles_provider` ON `model_profiles` (`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_model_profiles_provider_model` ON `model_profiles` (`provider_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`display_name` text NOT NULL,
	`auth_kind` text NOT NULL,
	`keychain_ref` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_providers_type` ON `providers` (`type`);--> statement-breakpoint
CREATE INDEX `idx_providers_active` ON `providers` (`is_active`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`title` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_profile_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_message_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace_projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`model_profile_id`) REFERENCES `model_profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_workspace` ON `sessions` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_last_message_at` ON `sessions` (`last_message_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`session_id` text,
	`message_id` text,
	`event_type` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_microunits` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_usage_provider_created` ON `usage_events` (`provider_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_session_created` ON `usage_events` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`trust_level` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_opened_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_projects_root_path_unique` ON `workspace_projects` (`root_path`);