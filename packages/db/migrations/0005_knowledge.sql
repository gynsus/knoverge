CREATE TABLE "knowledge_items" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(64) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"markdown_path" varchar(1024) NOT NULL,
	"type" varchar(24) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"language" varchar(8) NOT NULL,
	"current_revision_id" varchar(64),
	"review_state" varchar(20) DEFAULT 'unreviewed' NOT NULL,
	"evidence_state" varchar(20) DEFAULT 'none' NOT NULL,
	"disputed" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"source_system" varchar(64),
	"external_key" varchar(512),
	"created_by_actor_id" varchar(64) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_revisions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"knowledge_item_id" varchar(64) NOT NULL,
	"workspace_id" varchar(64) NOT NULL,
	"revision_number" bigint NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"frontmatter_hash" varchar(80) NOT NULL,
	"git_commit_hash" varchar(64) NOT NULL,
	"title" varchar(300) NOT NULL,
	"markdown_path" varchar(1024) NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"change_kind" varchar(20) NOT NULL,
	"created_by_actor_id" varchar(64) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"operation_id" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_item_categories" (
	"knowledge_item_id" varchar(64) NOT NULL,
	"category_id" varchar(64) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "knowledge_item_categories_pk" PRIMARY KEY ("knowledge_item_id", "category_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(64) NOT NULL,
	"name" varchar(64) NOT NULL,
	"normalised_name" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_item_tags" (
	"knowledge_item_id" varchar(64) NOT NULL,
	"tag_id" varchar(64) NOT NULL,
	CONSTRAINT "knowledge_item_tags_pk" PRIMARY KEY ("knowledge_item_id", "tag_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_workspace_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_actor_fk"
	FOREIGN KEY ("created_by_actor_id") REFERENCES "actors"("id");--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_item_fk"
	FOREIGN KEY ("knowledge_item_id") REFERENCES "knowledge_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_actor_fk"
	FOREIGN KEY ("created_by_actor_id") REFERENCES "actors"("id");--> statement-breakpoint
ALTER TABLE "knowledge_item_categories" ADD CONSTRAINT "knowledge_item_categories_item_fk"
	FOREIGN KEY ("knowledge_item_id") REFERENCES "knowledge_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_item_categories" ADD CONSTRAINT "knowledge_item_categories_category_fk"
	FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_item_tags" ADD CONSTRAINT "knowledge_item_tags_item_fk"
	FOREIGN KEY ("knowledge_item_id") REFERENCES "knowledge_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_item_tags" ADD CONSTRAINT "knowledge_item_tags_tag_fk"
	FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE;--> statement-breakpoint

-- The states are closed sets in the contracts; the database is where that stops
-- being a promise and becomes true of every row, whatever wrote it.
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_type_check" CHECK (
	"type" IN ('fact','decision','instruction','preference','procedure','observation','episode','document','insight','summary')
);--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_status_check" CHECK (
	"status" IN ('draft','active','superseded','archived','deleted')
);--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_review_check" CHECK (
	"review_state" IN ('unreviewed','agent_reviewed','human_reviewed')
);--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_evidence_check" CHECK (
	"evidence_state" IN ('none','source_backed','corroborated')
);--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_kind_check" CHECK (
	"change_kind" IN ('create','update','move','metadata','delete','restore','supersede','superseded_by','import')
);--> statement-breakpoint

-- The file path is derived from the slug, so a row whose path does not end in
-- its own slug describes a file that is not the one it names.
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_path_matches_slug" CHECK (
	"markdown_path" = 'knowledge/' || '_uncategorised/' || "slug" || '.md'
	OR "markdown_path" LIKE 'knowledge/%/' || "slug" || '.md'
);--> statement-breakpoint

-- A slug is unique inside its directory, which is what makes the path unique.
CREATE UNIQUE INDEX "knowledge_items_path_idx" ON "knowledge_items" ("workspace_id","markdown_path");--> statement-breakpoint
-- An externally sourced item is claimed once per system (CLAUDE.md, API rules).
CREATE UNIQUE INDEX "knowledge_items_external_idx" ON "knowledge_items" ("workspace_id","source_system","external_key")
	WHERE "source_system" IS NOT NULL AND "external_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "knowledge_items_workspace_idx" ON "knowledge_items" ("workspace_id","status");--> statement-breakpoint

CREATE UNIQUE INDEX "knowledge_revisions_number_idx" ON "knowledge_revisions" ("knowledge_item_id","revision_number");--> statement-breakpoint
CREATE INDEX "knowledge_revisions_item_idx" ON "knowledge_revisions" ("knowledge_item_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_revisions_commit_idx" ON "knowledge_revisions" ("workspace_id","git_commit_hash");--> statement-breakpoint

-- Exactly one primary category per item, when it has any at all.
CREATE UNIQUE INDEX "knowledge_item_categories_primary_idx" ON "knowledge_item_categories" ("knowledge_item_id")
	WHERE "is_primary";--> statement-breakpoint
CREATE INDEX "knowledge_item_categories_category_idx" ON "knowledge_item_categories" ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_normalised_idx" ON "tags" ("workspace_id","normalised_name");--> statement-breakpoint

-- Revisions are immutable, like ledger events and for the same reason: a
-- revision is the record that a commit was made, and a record that can be
-- edited afterwards records nothing. A correction is a new revision.
CREATE OR REPLACE FUNCTION "knoverge_revisions_are_immutable"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'knowledge_revisions is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "knowledge_revisions_no_update" BEFORE UPDATE OR DELETE ON "knowledge_revisions"
	FOR EACH ROW EXECUTE FUNCTION "knoverge_revisions_are_immutable"();--> statement-breakpoint
CREATE TRIGGER "knowledge_revisions_no_truncate" BEFORE TRUNCATE ON "knowledge_revisions"
	FOR EACH STATEMENT EXECUTE FUNCTION "knoverge_revisions_are_immutable"();
