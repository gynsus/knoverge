-- Two more jobs a model can be given.
--
-- The constraint written with the table listed the two purposes that existed
-- then. `vision` and `transcription` are two more models doing two more jobs —
-- one looks at a picture, one listens to a recording — and each is a separate
-- assignment because on most installations each is a separate model.
--
-- It is a `CHECK` and not an enum type for the reason it was one to begin with:
-- widening a list of allowed strings is this statement, and widening a
-- PostgreSQL enum is a type change that cannot be undone in a transaction.
ALTER TABLE "ai_assignments" DROP CONSTRAINT "ai_assignments_purpose_check";--> statement-breakpoint
ALTER TABLE "ai_assignments" ADD CONSTRAINT "ai_assignments_purpose_check"
	CHECK ("purpose" IN ('embedding', 'generation', 'vision', 'transcription'));
