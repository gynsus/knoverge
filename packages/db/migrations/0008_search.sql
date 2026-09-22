-- Search documents: a rebuildable projection of canonical content
-- (DATA_MODEL.md section 28). Git stays canonical; this is the index that
-- makes it findable, and `knoverge db reindex` rebuilds it from the files.

-- The text search configuration for a language tag.
--
-- A generated column needs an immutable expression, and `to_tsvector(text,
-- text)` is not immutable because a configuration can be changed under it.
-- Naming the configurations here makes the mapping immutable and keeps the
-- per-language behaviour rule "language-aware FTS" asks for. A language with
-- no configuration falls back to `simple`, which still matches exact words.
--
-- Everything inside is schema-qualified. `pg_restore` runs with an empty
-- search_path, so an unqualified `unaccent` is not found and the whole dump
-- fails to restore — which the backup drill catches and an operator would
-- otherwise discover on the day they needed the backup.
CREATE OR REPLACE FUNCTION knoverge_tsvector(language text, content text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT CASE language
    WHEN 'en' THEN pg_catalog.to_tsvector('pg_catalog.english', public.unaccent(content))
    WHEN 'ru' THEN pg_catalog.to_tsvector('pg_catalog.russian', public.unaccent(content))
    WHEN 'de' THEN pg_catalog.to_tsvector('pg_catalog.german', public.unaccent(content))
    WHEN 'fr' THEN pg_catalog.to_tsvector('pg_catalog.french', public.unaccent(content))
    WHEN 'es' THEN pg_catalog.to_tsvector('pg_catalog.spanish', public.unaccent(content))
    WHEN 'it' THEN pg_catalog.to_tsvector('pg_catalog.italian', public.unaccent(content))
    WHEN 'pt' THEN pg_catalog.to_tsvector('pg_catalog.portuguese', public.unaccent(content))
    WHEN 'nl' THEN pg_catalog.to_tsvector('pg_catalog.dutch', public.unaccent(content))
    ELSE pg_catalog.to_tsvector('pg_catalog.simple', public.unaccent(content))
  END
$$;

CREATE TABLE "search_documents" (
	"knowledge_item_id" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(64) NOT NULL,
	"revision_id" varchar(64) NOT NULL,
	"language" varchar(8) NOT NULL,
	"title" text NOT NULL,
	-- The body as the file holds it. The section lists only the vectors, and
	-- a vector cannot produce a snippet: `ts_headline` needs the words. When
	-- Milestone 6 adds search chunks, which carry their own text, this
	-- becomes the fallback for an item small enough not to be split.
	"body" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	-- One vector, with the title weighted above the body.
	--
	-- Separate vectors per field cannot answer a query whose words are split
	-- between them: `@@` wants every term in the vector it is testing, so
	-- "backup schedule" against a title "Backup" and a body "...schedule..."
	-- matches neither. Weights are how PostgreSQL means this to be done, and
	-- ranking reads them, so a title match still counts for more.
	"document_tsv" tsvector GENERATED ALWAYS AS (
		pg_catalog.setweight(public.knoverge_tsvector("language", "title"), 'A')
		|| pg_catalog.setweight(public.knoverge_tsvector("language", "body"), 'B')
	) STORED,
	-- The same, unstemmed. A query is parsed in one configuration and a
	-- workspace holds items in several: a Russian item in a workspace whose
	-- default is English would otherwise be unfindable, because English
	-- stemming and Russian stemming never produce the same token. This is the
	-- exact-word path that works whatever language either side is in.
	"simple_tsv" tsvector GENERATED ALWAYS AS (
		pg_catalog.setweight(public.knoverge_tsvector('simple', "title"), 'A')
		|| pg_catalog.setweight(public.knoverge_tsvector('simple', "body"), 'B')
	) STORED
);

ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_item_fk"
	FOREIGN KEY ("knowledge_item_id") REFERENCES "knowledge_items"("id") ON DELETE CASCADE;
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_workspace_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;

CREATE INDEX "search_documents_document_tsv_idx" ON "search_documents" USING gin ("document_tsv");
CREATE INDEX "search_documents_simple_tsv_idx" ON "search_documents" USING gin ("simple_tsv");
CREATE INDEX "search_documents_workspace_idx" ON "search_documents" ("workspace_id");
