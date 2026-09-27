CREATE TABLE "webhooks" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(40) NOT NULL,
	"url" text NOT NULL,
	-- Encrypted, not hashed: the server signs every delivery with it and has to
	-- be able to read it back. The key lives in the environment (ADR 0029).
	"secret_ciphertext" text NOT NULL,
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	-- The per-workspace ledger sequence this endpoint has been told about. A
	-- delivery that fails leaves it where it was, so the next attempt resends.
	"cursor" bigint DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_delivery_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhooks_workspace_idx" ON "webhooks" USING btree ("workspace_id");
