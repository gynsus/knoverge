-- One row per canonical write, so a write interrupted between Git and
-- PostgreSQL can be finished or abandoned (ARCHITECTURE.md section 4).
CREATE TABLE "operations" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(40) NOT NULL,
	"actor_id" varchar(40) NOT NULL,
	"operation_type" varchar(32) NOT NULL,
	"state" varchar(16) NOT NULL,
	"object_ids" jsonb NOT NULL,
	"intended_payload_hash" varchar(80),
	"git_commit_hash" varchar(64),
	"taxonomy_version" varchar(20),
	"request_id" varchar(128) NOT NULL,
	"session_id" varchar(128),
	"agent_id" varchar(40),
	"client" varchar(64),
	"provider" varchar(64),
	"model" varchar(128),
	"error" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id");--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id");--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_state_check" CHECK ("state" IN ('pending', 'git_committed', 'db_committed', 'failed', 'recovered'));--> statement-breakpoint
-- A commit hash belongs to an operation that reached Git, and only to one.
ALTER TABLE "operations" ADD CONSTRAINT "operations_commit_matches_state" CHECK (
	("state" IN ('pending', 'failed') AND "git_commit_hash" IS NULL)
	OR ("state" IN ('git_committed', 'db_committed', 'recovered') AND "git_commit_hash" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX "operations_workspace_state_idx" ON "operations" USING btree ("workspace_id","state");
