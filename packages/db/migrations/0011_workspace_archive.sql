-- A workspace that is kept but no longer written to.
--
-- Read-only rather than deleted: the knowledge, the history and the ledger of
-- a finished project stay exactly as they were, and the state is reversible,
-- so a workspace archived by mistake loses nothing. Nullable because the
-- absence of a date is the whole statement: this workspace is live.
ALTER TABLE "workspaces" ADD COLUMN "archived_at" timestamp with time zone;
