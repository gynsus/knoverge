-- Embeddings hang from chunks, under a profile that names what produced them.
--
-- A profile rather than a column on the chunk, because switching models must
-- not blank semantic search while a workspace is re-embedded: the new profile
-- fills as `rebuilding` while the old one keeps answering, and they change
-- places when it is complete (ADR 0020, DATA_MODEL.md section 29).
CREATE TABLE "embedding_profiles" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(40) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"model" varchar(128) NOT NULL,
	-- Read from the model's own answer, never configured: a number an
	-- operator has to keep in step with their model is a number that will
	-- eventually be wrong, and the consequence has no symptom.
	"dimensions" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "embedding_profiles_workspace_fk" FOREIGN KEY ("workspace_id")
		REFERENCES "workspaces"("id") ON DELETE cascade,
	CONSTRAINT "embedding_profiles_status_check"
		CHECK ("status" IN ('active', 'rebuilding', 'retired')),
	CONSTRAINT "embedding_profiles_dimensions_check" CHECK ("dimensions" > 0)
);--> statement-breakpoint

-- One profile answers queries, and one is being built. Two of either would
-- mean a query that has to choose, and a choice nobody wrote down.
CREATE UNIQUE INDEX "embedding_profiles_active_idx"
	ON "embedding_profiles" ("workspace_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_profiles_rebuilding_idx"
	ON "embedding_profiles" ("workspace_id") WHERE "status" = 'rebuilding';--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_profiles_model_idx"
	ON "embedding_profiles" ("workspace_id", "provider", "model", "dimensions");--> statement-breakpoint

CREATE TABLE "embeddings" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(40) NOT NULL,
	"profile_id" varchar(40) NOT NULL,
	"chunk_id" varchar(40) NOT NULL,
	-- Unconstrained on purpose. A dimension fixed in the DDL is what an index
	-- over vectors needs, and it would refuse every model that does not have
	-- that dimension; exact search needs no index and is exactly right at the
	-- size one self-hosted workspace reaches. When a workspace outgrows it,
	-- the index — and the fixed dimension — is a migration.
	"vector" vector NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "embeddings_workspace_fk" FOREIGN KEY ("workspace_id")
		REFERENCES "workspaces"("id") ON DELETE cascade,
	CONSTRAINT "embeddings_profile_fk" FOREIGN KEY ("profile_id")
		REFERENCES "embedding_profiles"("id") ON DELETE cascade,
	-- A chunk is rewritten whenever its item changes, and its embedding goes
	-- with it: a vector for text that no longer exists is worse than none.
	CONSTRAINT "embeddings_chunk_fk" FOREIGN KEY ("chunk_id")
		REFERENCES "search_chunks"("id") ON DELETE cascade
);--> statement-breakpoint

CREATE UNIQUE INDEX "embeddings_profile_chunk_idx" ON "embeddings" ("profile_id", "chunk_id");--> statement-breakpoint
CREATE INDEX "embeddings_workspace_idx" ON "embeddings" ("workspace_id");
