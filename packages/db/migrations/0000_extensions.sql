-- PostgreSQL extensions Knoverge relies on (docs/ARCHITECTURE.md, section 3).
-- vector:   pgvector, embeddings for semantic retrieval (Milestone 6)
-- pg_trgm:  trigram similarity for lexical matching and reconciliation
-- unaccent: accent-insensitive full-text search across languages
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
