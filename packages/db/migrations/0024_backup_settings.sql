-- Backups become a setting the product owns rather than a container in a
-- compose profile (ADR 0040).
--
-- One row, not a table: a schedule is a property of the installation. The CHECK
-- on the key is what enforces that; without it this would be a table that
-- happens to hold one row, and something would eventually insert a second.

CREATE TABLE "backup_settings" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"interval_hours" integer DEFAULT 24 NOT NULL,
	-- Local copies only. Nothing on the far machine is ever removed by us: a
	-- scheduled delete there, one wrong directory from the thing it protects,
	-- is not a feature to enable quietly.
	"retention_days" integer DEFAULT 14 NOT NULL,
	"target_host" varchar(255),
	"target_port" integer,
	"target_username" varchar(64),
	"target_directory" varchar(1024),
	"target_auth_kind" varchar(16),
	-- AES-256-GCM under KNOVERGE_ENCRYPTION_KEY, holding a private key or a
	-- password. Never served.
	"target_secret_ciphertext" text,
	"last_run_at" timestamp with time zone,
	"last_error" varchar(500),
	"last_upload_at" timestamp with time zone,
	"last_upload_error" varchar(500),
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "backup_settings_singleton_check" CHECK ("id" = 'singleton'),
	CONSTRAINT "backup_settings_auth_kind_check" CHECK ("target_auth_kind" IS NULL OR "target_auth_kind" IN ('private_key', 'password')),
	CONSTRAINT "backup_settings_interval_check" CHECK ("interval_hours" BETWEEN 1 AND 168),
	CONSTRAINT "backup_settings_retention_check" CHECK ("retention_days" BETWEEN 1 AND 365),
	-- A target is all of its parts or none of them. Half a target is a setting
	-- that looks configured and uploads nowhere.
	CONSTRAINT "backup_settings_target_whole_check" CHECK (
		("target_host" IS NULL AND "target_port" IS NULL AND "target_username" IS NULL
		 AND "target_directory" IS NULL AND "target_auth_kind" IS NULL)
		OR
		("target_host" IS NOT NULL AND "target_port" IS NOT NULL AND "target_username" IS NOT NULL
		 AND "target_directory" IS NOT NULL AND "target_auth_kind" IS NOT NULL)
	)
);
--> statement-breakpoint
-- The row exists from here, so the settings screen has something to read and
-- says "off" rather than saying nothing. An installation that never thinks
-- about backups still has none; what it gains is being told.
INSERT INTO "backup_settings" ("id", "updated_at") VALUES ('singleton', now());
