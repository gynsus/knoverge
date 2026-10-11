-- Gardening: the installation reading its own knowledge on a schedule and
-- filing what it finds (ADR 0039, ADR 0042).
--
-- Per workspace rather than per installation, unlike the backup settings: a
-- workspace is the unit of knowledge and of review, so it is the unit of
-- tidying. One may want it and the next may not, and the review queue a flood
-- would ruin belongs to a workspace.

CREATE TABLE "gardening_settings" (
	"workspace_id" varchar(40) PRIMARY KEY NOT NULL,
	-- Off until somebody turns it on. The first thing gardening does is make
	-- work for people, and a workspace that has just imported a vault should
	-- not find proposals waiting before anybody asked for any.
	"enabled" boolean DEFAULT false NOT NULL,
	"interval_hours" integer DEFAULT 24 NOT NULL,
	-- What one run and one rule may leave in the review queue. A gardener that
	-- buries the queue has done harm, not work: the proposals from people and
	-- agents are the ones somebody is waiting on. A rule that would exceed its
	-- cap reports the count instead of filing the rest.
	"max_findings_per_run" integer DEFAULT 50 NOT NULL,
	"max_findings_per_rule" integer DEFAULT 20 NOT NULL,
	"last_run_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gardening_settings_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
	CONSTRAINT "gardening_settings_interval_check" CHECK ("interval_hours" BETWEEN 1 AND 168),
	CONSTRAINT "gardening_settings_per_run_check" CHECK ("max_findings_per_run" BETWEEN 1 AND 500),
	CONSTRAINT "gardening_settings_per_rule_check" CHECK ("max_findings_per_rule" BETWEEN 1 AND 500)
);
--> statement-breakpoint
-- No row is inserted for the workspaces that exist. A workspace with no row has
-- the defaults, which is what the screen shows and what the sweep reads, and
-- the row appears when somebody changes something. Backfilling would have to be
-- repeated by workspace creation and by import, and three places that create
-- the same row are three places one of them can be forgotten.

-- What a run did. The findings are proposals and live in the review queue; this
-- is the run itself, so the screen can tell a rule that found nothing from a
-- rule that never ran.
--
-- Kept rather than pruned: one row per workspace per day is three hundred and
-- sixty-five a year, each a few hundred bytes. The sync candidates were pruned
-- because a daily pass left three hundred thousand.
CREATE TABLE "gardening_runs" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(40) NOT NULL,
	-- `scheduled` or `requested`: a run somebody asked for reads differently
	-- from one the schedule took, and the screen says which it is looking at.
	"trigger" varchar(16) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	-- Null while it runs, which is also how a run interrupted by a restart is
	-- recognisable afterwards.
	"finished_at" timestamp with time zone,
	"findings_filed" integer DEFAULT 0 NOT NULL,
	-- True when the run stopped because it had filed as much as it may. What
	-- was not filed is not lost: the next run finds it again.
	"reached_cap" boolean DEFAULT false NOT NULL,
	-- One line, never a body.
	"error" varchar(500),
	-- One entry per rule: what it read, what it found, what it filed, and why
	-- it filed less than it found or did not run. Read as a block for one
	-- screen and never queried by its contents, which is what makes it a
	-- document and not a table.
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "gardening_runs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
	CONSTRAINT "gardening_runs_trigger_check" CHECK ("trigger" IN ('scheduled', 'requested'))
);
--> statement-breakpoint
CREATE INDEX "gardening_runs_workspace_idx" ON "gardening_runs" ("workspace_id","started_at" DESC);
