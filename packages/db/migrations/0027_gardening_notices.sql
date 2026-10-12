-- A gardening finding that names no write (ADR 0043).
--
-- The first two rules name one: this item should stop being active because that
-- one says the same thing, which is a proposal a reviewer agrees with or does
-- not. The rules that follow mostly name nothing a reviewer could approve — a
-- source reference no revision cites, an attachment whose every item is gone —
-- and a review queue item nobody can approve is one that can never be cleared.
--
-- So they go on the run that found them. Not in a table of their own: a table
-- would exist to hold a row's lifecycle, and a notice has none. It is true
-- until the thing it describes is fixed, and then the next run does not report
-- it.

ALTER TABLE "gardening_runs"
	-- [{ rule, subject_type, subject_id, reason }]. The rule so a reader can
	-- disagree with the rule rather than with one notice, and the subject so
	-- they can go and look at it.
	ADD COLUMN "notices" jsonb DEFAULT '[]'::jsonb NOT NULL;
