CREATE TABLE IF NOT EXISTS `ssh_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`auth` text NOT NULL,
	`username` text NOT NULL,
	`secret_encrypted` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
