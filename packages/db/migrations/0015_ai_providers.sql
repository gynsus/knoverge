-- Where an AI provider is configured.
--
-- Not in the environment: an operator points at a server, finds out whether it
-- answers, sees which models it holds and changes their mind, and every step of
-- that needed a container restart. The variables still provision a first start;
-- after that this is the answer (ADR 0021, DATA_MODEL.md section 30).
--
-- Instance-level, with no workspace column: one Ollama server is not a property
-- of a workspace.
CREATE TABLE "ai_providers" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"name" varchar(64) NOT NULL,
	"base_url" varchar(512) NOT NULL,
	-- Who configured it: the first start read the environment, or somebody
	-- used the interface. The question an operator asks first when the
	-- compose file and the settings page disagree.
	"origin" varchar(16) NOT NULL,
	"last_checked_at" timestamp with time zone,
	-- One line, never a body: the provider is somebody else's server and its
	-- errors may quote a request.
	"last_error" varchar(500),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_providers_kind_check" CHECK ("kind" IN ('ollama', 'openai_compatible')),
	CONSTRAINT "ai_providers_origin_check" CHECK ("origin" IN ('environment', 'interface'))
);--> statement-breakpoint

-- No two providers at the same address: two rows for one server are two places
-- to change a setting and one of them will be forgotten.
CREATE UNIQUE INDEX "ai_providers_base_url_idx" ON "ai_providers" ("base_url");--> statement-breakpoint

-- Which provider and model answer for a purpose.
--
-- The purpose is the key, so there is one answer to "what embeds" rather than a
-- list to choose from. `generation` is allowed and nothing reads it: it has no
-- consumer until Milestone 8, and leaving it out would mean a migration to add
-- one row type.
CREATE TABLE "ai_assignments" (
	"purpose" varchar(32) PRIMARY KEY NOT NULL,
	"provider_id" varchar(40) NOT NULL,
	"model" varchar(200) NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	-- Removing a provider removes what it was doing. The alternative is an
	-- assignment pointing at nothing, which reads as configured and embeds
	-- nothing.
	CONSTRAINT "ai_assignments_provider_fk" FOREIGN KEY ("provider_id")
		REFERENCES "ai_providers"("id") ON DELETE cascade,
	CONSTRAINT "ai_assignments_purpose_check" CHECK ("purpose" IN ('embedding', 'generation'))
);
