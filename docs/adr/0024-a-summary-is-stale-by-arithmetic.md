# ADR 0024: A summary is stale by arithmetic, not by a job

- Status: Accepted
- Date: 2026-09-26

## Context

Rule 7 says a summary keeps explicit dependencies on source revisions, and that
a summary whose dependency changed is stale.

Two documents describe how. `DATA_MODEL.md` section 27 says "any new canonical
revision of a dependency item marks related summaries stale", which reads as an
action somebody takes. `ARCHITECTURE.md` lists `stale-summary detection` among
the jobs and `summary.marked_stale` among the ledger event types.
`KNOWLEDGE_MODEL.md` section 12 lists a `stale boolean` on the summary item
itself.

Together they describe a stored flag, a job that sets it, and an event recording
that it was set. Nothing is built yet, so the question is open, and ADR 0022 has
just answered a version of it for `disputed`: derive, never set.

## Decision

**A summary is stale when any revision it names is no longer the current
revision of the item it names. That is computed, not stored.**

```text
stale(S) = ∃ (item, revision) in S's dependencies
           where item.current_revision_id <> revision
```

There is no `stale` column, no job that sets one, no `summary.marked_stale`
event, and no `stale` field in the frontmatter. `KNOWLEDGE_MODEL.md` section 12
is amended, and `ARCHITECTURE.md` loses a job it never gained.

The dependencies themselves *are* stored, twice, the way everything canonical is:
`summary_of` in the summary's frontmatter carries `<item id>@<revision id>` for
each source, and `summary_dependencies` in PostgreSQL carries the same pairs as
the queryable index (rule 2).

**Why this is different from `disputed`.** That flag is stored in frontmatter,
maintained by writes, because a reader with the repository and no application
would otherwise be told nothing about whether the claim in front of them is
contested. A summary's file has no such gap: it already names the exact revisions
it was made from, which is the durable fact and the portable one. Whether those
revisions are still current is a question about the present, and rule 2 makes
PostgreSQL authoritative for the present.

**Why not a job.** A job that sets a flag is a flag that is wrong between the
write and the job. Every consumer would then need to know whether staleness is
fresh, which is a second question nobody wants to ask. Computing it removes the
question: it is right the instant a dependency is written, because there is
nothing to catch up.

**Why not a fan-out, as ADR 0022 uses.** A summary of twenty items would gain a
metadata revision, and a Git commit, every time any of the twenty changed.
Twenty items changing once each is twenty commits that say nothing about the
summary's own content. Rule 4 asks for material changes only, and a dependency
moving is a fact about the dependency.

## Consequences

- `KnowledgeItemSummary` gains `stale`, computed. It is false for everything that
  is not a summary, which is honest: an item with no dependencies cannot be out
  of step with them.
- The list can offer a pile of summaries that need looking at, and the count is
  exact rather than as fresh as the last job run.
- A summary regenerated from current revisions stops being stale by having new
  dependencies written, with no separate step that says so.
- `summary_dependencies` rows are replaced whole when a summary is written, the
  way relations and tags are. A dependency that was once true is part of the
  history of the revision that named it, and the revision keeps its own
  `summary_of` in its stored frontmatter.
- Deleting a source item does not make a summary stale: the item's current
  revision is the delete revision, which *is* a change, so it does. That is
  right — a summary of something that has been removed from the active index is
  exactly a summary somebody should look at.
- There is no way to say "I know it is stale and I accept it". If that turns out
  to be wanted, it is a new revision of the summary naming the current revisions,
  which is the honest form of that statement: you have read them and you say the
  summary still holds.

## Alternatives considered

**A stored flag set by a job, as the documents describe.** Rejected for the
reason a derived value is preferred everywhere else in this codebase: two
sources for one fact, and a window in which the stored one is wrong. It also
needs a ledger event to explain itself, and "a job noticed something" is not a
material change to knowledge.

**A stored flag maintained by the writes that cause it, like `disputed`.**
Consistent with ADR 0022 and rejected on cost: one commit per dependency per
change, for a fact the summary's own file can already be checked against.

**`stale` in the frontmatter, computed at write time only.** The worst of both:
a file that says `stale: false` and becomes wrong an hour later, with nothing to
correct it until somebody writes the summary again.

**No staleness at all — let a reader compare `summary_of` themselves.** Rejected
because rule 7 asks for it and because the comparison needs the current revision
id of every source, which is not something a reader has to hand. Computing it is
one join.
