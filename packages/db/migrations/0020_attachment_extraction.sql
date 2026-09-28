-- What the text inside a file became is not a column here.
--
-- The item made from a file carries a source naming this attachment, and that
-- source is the link: canonical, in the frontmatter, and still true in a
-- repository read without this software. A column pointing the other way is the
-- same fact in a second place, and after an agent's proposal is approved only one
-- of the two would be right (ADR 0008).
ALTER TABLE "attachments" DROP COLUMN "document_item_id";--> statement-breakpoint
-- When a worker took this file to read it.
--
-- The claim is the state change: one statement moves a row from `pending` to
-- `extracting`, so two workers cannot both take the same file and write the same
-- document twice. This is what says the worker that took it has died — anything
-- left `extracting` for long enough is claimed again.
ALTER TABLE "attachments" ADD COLUMN "extraction_started_at" timestamp with time zone;--> statement-breakpoint
-- What the sweep looks for: oldest first, across every workspace.
CREATE INDEX "attachments_unread_idx" ON "attachments" USING btree ("created_at") WHERE "extraction_state" IN ('pending', 'extracting');
