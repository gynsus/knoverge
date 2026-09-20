CREATE TABLE "source_references" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(64) NOT NULL,
	"source_type" varchar(32) NOT NULL,
	"uri" varchar(2048),
	"external_system" varchar(64),
	"external_key" varchar(512),
	"attachment_id" varchar(64),
	"source_modified_at" timestamp with time zone,
	"source_content_hash" varchar(80),
	"confidence" real,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision_sources" (
	"revision_id" varchar(64) NOT NULL,
	"source_reference_id" varchar(64) NOT NULL,
	"evidence_role" varchar(16) DEFAULT 'primary' NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "revision_sources_pk" PRIMARY KEY ("revision_id", "source_reference_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_relations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(64) NOT NULL,
	"from_item_id" varchar(64) NOT NULL,
	"relation_type" varchar(24) NOT NULL,
	"to_item_id" varchar(64) NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"created_by_actor_id" varchar(64) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "source_references" ADD CONSTRAINT "source_references_workspace_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "revision_sources" ADD CONSTRAINT "revision_sources_revision_fk"
	FOREIGN KEY ("revision_id") REFERENCES "knowledge_revisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "revision_sources" ADD CONSTRAINT "revision_sources_source_fk"
	FOREIGN KEY ("source_reference_id") REFERENCES "source_references"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_workspace_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_from_fk"
	FOREIGN KEY ("from_item_id") REFERENCES "knowledge_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_to_fk"
	FOREIGN KEY ("to_item_id") REFERENCES "knowledge_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_actor_fk"
	FOREIGN KEY ("created_by_actor_id") REFERENCES "actors"("id");--> statement-breakpoint

ALTER TABLE "source_references" ADD CONSTRAINT "source_references_type_check" CHECK (
	"source_type" IN ('human_input','agent_session','web_url','file','attachment','email','git_commit','external_system','other_knowledge_item')
);--> statement-breakpoint
ALTER TABLE "revision_sources" ADD CONSTRAINT "revision_sources_role_check" CHECK (
	"evidence_role" IN ('primary','supporting','derived','contradicting')
);--> statement-breakpoint
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_type_check" CHECK (
	"relation_type" IN ('supersedes','implements','derived_from','contradicts','duplicates','depends_on','relates_to')
);--> statement-breakpoint
-- An item relating to itself says nothing and breaks every traversal.
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_not_self" CHECK (
	"from_item_id" <> "to_item_id"
);--> statement-breakpoint
ALTER TABLE "source_references" ADD CONSTRAINT "source_references_confidence_range" CHECK (
	"confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)
);--> statement-breakpoint

-- One live relation of a kind between two items. A removed one stays for the
-- history and does not block the pair being related again.
CREATE UNIQUE INDEX "knowledge_relations_live_idx" ON "knowledge_relations"
	("from_item_id","relation_type","to_item_id") WHERE "removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "knowledge_relations_to_idx" ON "knowledge_relations" ("to_item_id","relation_type");--> statement-breakpoint
CREATE INDEX "source_references_workspace_idx" ON "source_references" ("workspace_id","source_type");--> statement-breakpoint
-- The same source cited twice is one row: a URI, or an external record, or a
-- fingerprint of the bytes, identifies it.
CREATE UNIQUE INDEX "source_references_uri_idx" ON "source_references" ("workspace_id","uri")
	WHERE "uri" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "source_references_external_idx" ON "source_references"
	("workspace_id","external_system","external_key")
	WHERE "external_system" IS NOT NULL AND "external_key" IS NOT NULL;
