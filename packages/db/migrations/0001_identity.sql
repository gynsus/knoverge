CREATE TABLE "actors" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(40) NOT NULL,
	"type" varchar(16) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"user_id" varchar(40),
	"agent_id" varchar(40),
	"created_at" timestamp with time zone NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"agent_id" varchar(40) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"token_prefix" varchar(32) NOT NULL,
	"label" varchar(120),
	"created_by_actor_id" varchar(40) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "agent_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(40) NOT NULL,
	"actor_id" varchar(40) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"client_type" varchar(64),
	"trust_tier" varchar(16) DEFAULT 'propose' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_by_actor_id" varchar(40) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(40) NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"actor_id" varchar(40) NOT NULL,
	"agent_id" varchar(40),
	"request_id" varchar(128) NOT NULL,
	"session_id" varchar(128),
	"client" varchar(64),
	"provider" varchar(64),
	"model" varchar(128),
	"object_type" varchar(32) NOT NULL,
	"object_id" varchar(128) NOT NULL,
	"before_revision_id" varchar(40),
	"before_content_hash" varchar(80),
	"after_revision_id" varchar(40),
	"after_content_hash" varchar(80),
	"proposal_id" varchar(40),
	"source_reference_id" varchar(40),
	"category_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_event_hash" text NOT NULL,
	"event_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"workspace_id" varchar(40) NOT NULL,
	"actor_id" varchar(40) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_records_workspace_id_actor_id_idempotency_key_pk" PRIMARY KEY("workspace_id","actor_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "human_sessions" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip" varchar(64),
	CONSTRAINT "human_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"locale" varchar(8) DEFAULT 'en' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"mfa" jsonb,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"password_changed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_memberships" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(40) NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"role" varchar(16) NOT NULL,
	"actor_id" varchar(40) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"default_language" varchar(8) DEFAULT 'en' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_sessions" ADD CONSTRAINT "human_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actors_workspace_idx" ON "actors" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actors_workspace_system_idx" ON "actors" USING btree ("workspace_id") WHERE type = 'system';--> statement-breakpoint
CREATE INDEX "agent_credentials_agent_idx" ON "agent_credentials" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agents_workspace_idx" ON "agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_workspace_name_idx" ON "agents" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "events_workspace_sequence_idx" ON "events" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE INDEX "events_workspace_object_idx" ON "events" USING btree ("workspace_id","object_type","object_id");--> statement-breakpoint
CREATE INDEX "events_workspace_type_idx" ON "events" USING btree ("workspace_id","event_type");--> statement-breakpoint
CREATE INDEX "idempotency_records_expires_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "human_sessions_user_idx" ON "human_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_memberships_workspace_user_idx" ON "workspace_memberships" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_memberships_user_idx" ON "workspace_memberships" USING btree ("user_id");--> statement-breakpoint
-- The event ledger is append-only (ADR 0007). Reject UPDATE and DELETE at the database level.
CREATE OR REPLACE FUNCTION events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only: % on events is not allowed', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER events_immutable
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_reject_mutation();
