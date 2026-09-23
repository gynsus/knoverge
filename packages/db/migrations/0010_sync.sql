-- Reconciliation: where an agent got to, what it offered, and what we made of it.
--
-- An agent arriving with knowledge it already holds is the case this product
-- exists for. Matching one write at a time already works; these three tables
-- are the session around it, so a client can offer a thousand candidates,
-- learn which of them the workspace already has, and resume where it stopped.

-- Per agent and per source, because one agent may carry knowledge from several
-- places and each moves at its own pace. A single checkpoint across them all
-- would make a full rescan the only safe answer whenever any one changed.
CREATE TABLE "agent_sync_state" (
  "id" varchar(40) PRIMARY KEY NOT NULL,
  "workspace_id" varchar(40) NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "agent_id" varchar(40) NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "source_system" varchar(64) NOT NULL,
  "source_namespace" varchar(512),
  "last_completed_sync_id" varchar(40),
  "last_change_sequence" integer,
  "last_taxonomy_version" integer,
  "last_completed_at" timestamp with time zone
);

-- Coalesced, because two nulls are not equal to PostgreSQL and a source with
-- no namespace is one source rather than a new one on every sync.
CREATE UNIQUE INDEX "agent_sync_state_source_idx"
  ON "agent_sync_state" ("workspace_id", "agent_id", "source_system", coalesce("source_namespace", ''));

CREATE TABLE "sync_sessions" (
  "id" varchar(40) PRIMARY KEY NOT NULL,
  "workspace_id" varchar(40) NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "agent_id" varchar(40) NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "source_system" varchar(64) NOT NULL,
  "source_namespace" varchar(512),
  "state" varchar(24) NOT NULL DEFAULT 'open',
  "taxonomy_version" integer NOT NULL,
  "change_sequence_at_start" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "stats_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "sync_sessions_state_check"
    CHECK ("state" IN ('open', 'processing', 'waiting_for_agent', 'completed', 'failed', 'expired')),
  -- A session is finished exactly when it says it is. Without this a completed
  -- session with no completion time is a checkpoint nobody can date.
  CONSTRAINT "sync_sessions_completed_check"
    CHECK (("state" = 'completed') = ("completed_at" IS NOT NULL))
);

CREATE INDEX "sync_sessions_workspace_idx"
  ON "sync_sessions" ("workspace_id", "agent_id", "created_at");

CREATE TABLE "sync_candidates" (
  "id" varchar(40) PRIMARY KEY NOT NULL,
  "sync_session_id" varchar(40) NOT NULL REFERENCES "sync_sessions"("id") ON DELETE CASCADE,
  "client_candidate_id" varchar(200) NOT NULL,
  "external_key" varchar(512),
  "source_content_hash" varchar(80),
  "candidate_content_hash" varchar(80),
  "source_modified_at" timestamp with time zone,
  "title" text NOT NULL,
  "knowledge_type" varchar(32) NOT NULL,
  "language" varchar(8),
  "proposed_category_paths_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "abstract" text,
  "classification" varchar(24) NOT NULL,
  "classification_state" varchar(16) NOT NULL,
  "match_reason" varchar(24) NOT NULL,
  "matched_item_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "server_reason_json" jsonb,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "sync_candidates_classification_check"
    CHECK ("classification" IN (
      'exact_known', 'likely_match', 'new_candidate', 'conflict',
      'agent_copy_stale', 'server_copy_stale', 'ambiguous', 'ignored'
    )),
  CONSTRAINT "sync_candidates_state_check"
    CHECK ("classification_state" IN ('provisional', 'final')),
  CONSTRAINT "sync_candidates_reason_check"
    CHECK ("match_reason" IN ('external_key', 'content_hash', 'lexical', 'semantic', 'none'))
);

-- The idempotency key inside a session: a resubmitted batch updates rather
-- than duplicates.
CREATE UNIQUE INDEX "sync_candidates_client_id_idx"
  ON "sync_candidates" ("sync_session_id", "client_candidate_id");

-- Paging a session, and finding what a background job still owes an answer for.
CREATE INDEX "sync_candidates_state_idx"
  ON "sync_candidates" ("sync_session_id", "classification_state", "id");
