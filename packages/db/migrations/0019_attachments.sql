CREATE TABLE "attachments" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(40) NOT NULL,
	-- `sha256:<hex>` of the bytes. The file itself lives under the data directory
	-- at attachments/<workspace_id>/<hex>, never in Git (ADR 0008).
	"content_hash" varchar(80) NOT NULL,
	"media_type" varchar(160) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"filename" text NOT NULL,
	"original_uri" text,
	"extraction_state" varchar(16) DEFAULT 'pending' NOT NULL,
	"extraction_error" text,
	-- The `document` item made from the text inside, once there is one.
	"document_item_id" varchar(40),
	"uploaded_by_actor_id" varchar(40) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	-- One row per file per workspace: the same bytes uploaded twice are one
	-- attachment. Per workspace and not globally, so uploading a file cannot tell
	-- you whether another workspace already holds it.
	CONSTRAINT "attachments_workspace_content_key" UNIQUE("workspace_id","content_hash")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Set null rather than cascade: purging the item made from a file must not take
-- the record of the file with it, or the bytes on disk would have nothing
-- pointing at them.
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_document_item_id_knowledge_items_id_fk" FOREIGN KEY ("document_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_actor_id_actors_id_fk" FOREIGN KEY ("uploaded_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_workspace_idx" ON "attachments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "attachments_document_idx" ON "attachments" USING btree ("document_item_id");
