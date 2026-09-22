-- Which version of the terms of use the person accepted, and when.
--
-- An unrecorded click protects nobody: the point of asking is being able to
-- answer later who agreed to what. Nullable because every user who existed
-- before this column was never asked, and inventing an answer for them would
-- be worse than an honest null.
ALTER TABLE "users" ADD COLUMN "terms_version" varchar(32);
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp with time zone;
