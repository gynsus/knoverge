-- What a summary was made from.
--
-- Rule 7: a summary keeps explicit dependencies on source revisions, and a
-- summary whose dependency has moved on is stale. Both halves live here — the
-- pairs are stored, and staleness is computed from them against the items'
-- current revisions rather than kept as a flag somebody has to maintain
-- (ADR 0024, DATA_MODEL.md section 27).
--
-- The revision, not just the item: "this summarises these five facts" is not
-- the claim. The claim is "this summarises these five facts as they read at
-- these five revisions", and only the second one can go out of date.
CREATE TABLE "summary_dependencies" (
	"summary_item_id" varchar(40) NOT NULL,
	"source_item_id" varchar(40) NOT NULL,
	"source_revision_id" varchar(40) NOT NULL,
	-- The order they were given, so a summary lists its sources the way whoever
	-- wrote it did rather than the way the database happened to return them.
	"position" integer NOT NULL,
	CONSTRAINT "summary_dependencies_pkey" PRIMARY KEY ("summary_item_id", "source_item_id"),
	-- One entry per source item: a summary naming the same item at two
	-- revisions is a summary that cannot say which one it used.
	CONSTRAINT "summary_dependencies_not_self" CHECK ("summary_item_id" <> "source_item_id")
);--> statement-breakpoint

ALTER TABLE "summary_dependencies" ADD CONSTRAINT "summary_dependencies_summary_fk"
	FOREIGN KEY ("summary_item_id") REFERENCES "knowledge_items"("id") ON DELETE cascade;--> statement-breakpoint

-- Restricted, not cascaded: a source disappearing would leave a summary that
-- silently forgets what it was made from, and rule 7 says the dependency is
-- explicit. Items are deleted logically, so this is only reached by a hard
-- delete, which is not something the product does.
ALTER TABLE "summary_dependencies" ADD CONSTRAINT "summary_dependencies_source_fk"
	FOREIGN KEY ("source_item_id") REFERENCES "knowledge_items"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "summary_dependencies" ADD CONSTRAINT "summary_dependencies_revision_fk"
	FOREIGN KEY ("source_revision_id") REFERENCES "knowledge_revisions"("id") ON DELETE restrict;--> statement-breakpoint

-- Which summaries depend on an item, which is the direction staleness is asked
-- in: an item was written, and the question is who was reading it.
CREATE INDEX "summary_dependencies_source_idx" ON "summary_dependencies" ("source_item_id");
