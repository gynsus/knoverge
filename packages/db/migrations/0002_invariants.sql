-- The invariants the domain has always relied on, stated where they are enforced.
--
-- Until now they lived only in TypeScript: a repository cast a column to a union
-- type and a bad value propagated into the domain as a well-typed lie, a
-- dangling or cyclic parent had nothing to stop it, and a path could disagree
-- with the slug it is supposed to end in.

-- A category's parent is a real category. Without this a parent id could point
-- at nothing, or at a category in another workspace.
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_parent_id_categories_id_fk"
  FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id");--> statement-breakpoint

-- A category's path is its parent's path plus its own slug, so it must end in
-- the slug. This is what a lost path rewrite used to break, and a lost path
-- takes every category-scoped grant that covered the branch with it.
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_path_ends_with_slug"
  CHECK ("path" = "slug" OR right("path", length("slug") + 1) = '/' || "slug");--> statement-breakpoint

-- Actor references point at actors.
ALTER TABLE "workspace_memberships"
  ADD CONSTRAINT "workspace_memberships_actor_id_actors_id_fk"
  FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id");--> statement-breakpoint
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_created_by_actor_id_actors_id_fk"
  FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id");--> statement-breakpoint
ALTER TABLE "agent_credentials"
  ADD CONSTRAINT "agent_credentials_created_by_actor_id_actors_id_fk"
  FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id");--> statement-breakpoint
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_created_by_actor_id_actors_id_fk"
  FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id");--> statement-breakpoint
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_actor_id_actors_id_fk"
  FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id");--> statement-breakpoint
ALTER TABLE "events"
  ADD CONSTRAINT "events_actor_id_actors_id_fk"
  FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id");--> statement-breakpoint

-- Enum-shaped columns hold one of their values. The repositories cast these
-- straight into union types, so anything else becomes a lie the domain believes.
ALTER TABLE "actors"
  ADD CONSTRAINT "actors_type_check" CHECK ("type" IN ('human', 'agent', 'system'));--> statement-breakpoint
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_trust_tier_check"
  CHECK ("trust_tier" IN ('read_only', 'propose', 'trusted'));--> statement-breakpoint
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_status_check" CHECK ("status" IN ('active', 'disabled'));--> statement-breakpoint
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_status_check"
  CHECK ("status" IN ('proposed', 'active', 'archived', 'merged', 'rejected'));--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_status_check" CHECK ("status" IN ('active', 'disabled'));--> statement-breakpoint
ALTER TABLE "workspace_memberships"
  ADD CONSTRAINT "workspace_memberships_role_check"
  CHECK ("role" IN ('owner', 'admin', 'reviewer', 'viewer'));--> statement-breakpoint
ALTER TABLE "permission_grants"
  ADD CONSTRAINT "permission_grants_effect_check" CHECK ("effect" IN ('allow', 'deny'));--> statement-breakpoint
ALTER TABLE "policy_rules"
  ADD CONSTRAINT "policy_rules_effect_check"
  CHECK ("effect" IN ('deny', 'allow_direct', 'require_review'));--> statement-breakpoint

-- The append-only trigger is per row, so it never saw a TRUNCATE. Application
-- code cannot issue one, but the ledger's promise is about the table, not about
-- the application.
CREATE OR REPLACE FUNCTION events_reject_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only: TRUNCATE on events is not allowed'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_reject_truncate();
