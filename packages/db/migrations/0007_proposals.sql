CREATE TABLE "proposals" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(64) NOT NULL,
	"proposal_type" varchar(32) NOT NULL,
	"target_item_id" varchar(64),
	"target_category_id" varchar(64),
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"proposed_by_actor_id" varchar(64) NOT NULL,
	"base_revision_id" varchar(64),
	"base_content_hash" varchar(80),
	"proposed_payload" jsonb NOT NULL,
	"reason" text,
	"confidence" real,
	"acknowledged_duplicate_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sync_session_id" varchar(64),
	"policy_decision" varchar(16) NOT NULL,
	"policy_rule_id" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_actor_id" varchar(64),
	"resolution_note" text,
	"result_revision_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_workspace_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_proposer_fk"
	FOREIGN KEY ("proposed_by_actor_id") REFERENCES "actors"("id");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_resolver_fk"
	FOREIGN KEY ("resolved_by_actor_id") REFERENCES "actors"("id");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_item_fk"
	FOREIGN KEY ("target_item_id") REFERENCES "knowledge_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_category_fk"
	FOREIGN KEY ("target_category_id") REFERENCES "categories"("id") ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "proposals" ADD CONSTRAINT "proposals_type_check" CHECK (
	"proposal_type" IN ('knowledge_create','knowledge_update','knowledge_delete','knowledge_supersede','category_create','category_update')
);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_status_check" CHECK (
	"status" IN ('pending','approved','approved_with_edits','rejected','superseded','withdrawn','conflict')
);--> statement-breakpoint
-- A denial never becomes a proposal, so only these two can be recorded.
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_policy_check" CHECK (
	"policy_decision" IN ('allow_direct','require_review')
);--> statement-breakpoint
-- A resolved proposal names who resolved it and when; a pending one names
-- neither. Half a resolution is a proposal nobody can account for.
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_resolution_consistent" CHECK (
	("status" = 'pending' AND "resolved_at" IS NULL AND "resolved_by_actor_id" IS NULL)
	OR ("status" <> 'pending' AND "resolved_at" IS NOT NULL AND "resolved_by_actor_id" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_confidence_range" CHECK (
	"confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)
);--> statement-breakpoint

-- The review inbox: what is waiting, oldest first.
CREATE INDEX "proposals_pending_idx" ON "proposals" ("workspace_id","created_at") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "proposals_workspace_idx" ON "proposals" ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "proposals_item_idx" ON "proposals" ("target_item_id") WHERE "target_item_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "proposals_proposer_idx" ON "proposals" ("proposed_by_actor_id","created_at");
