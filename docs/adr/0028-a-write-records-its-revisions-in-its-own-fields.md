# 28. A write records its revisions in its own fields

Date: 2026-09-27

Status: accepted

## Context

Rule 3 lists what every material write records, and two of the items on that list
are the revision and content hash on each side of the change. The `events` table
has four columns for them — `before_revision_id`, `before_content_hash`,
`after_revision_id`, `after_content_hash` — and `EventSummary` serves all four.

Nothing wrote them. Knowledge writes put the same facts in `metadata`, under
`revision`, `content_hash`, `before_revision` and `before_hash`, and the two
places that needed them read the metadata first and the columns second. An agent
reading the audit feed through the contract was handed four nulls for facts the
row was holding a few bytes away, under names no schema mentions.

Two representations of one fact, and the typed one lost.

## Decision

The revision and hash on each side are the event's own fields. Every append that
knows them passes them: create, update, move, supersede (both ends), delete,
restore, a dispute verdict on a partner item, and recovery finishing an
interrupted write. `metadata` keeps `frontmatter_hash`, which has no column, and
everything that is genuinely metadata — the commit, the change kind, the category
snapshots.

**Events already written are not rewritten.** The hash covers the event's fields
*and* its metadata (ADR 0007), so moving a value from the bag into a column would
change what was signed and break the chain from that row onward — `knoverge ledger
verify` would fail, which is exactly what it exists to report. Rule 4 says
application code never updates an existing event, and a migration is application
code with a longer reach.

The database says so too: a `BEFORE UPDATE OR DELETE` trigger on `events` raises
rather than letting the row change. A backfill was written for this decision and
would have been rejected by it, which is the invariant doing its job on the person
who wrote the invariant. So history keeps the shape it was written in.

The consequence is a fallback, in the two feeds that answer "which revision did
this produce": the column first, the metadata second. It is not a symmetry to be
tidied away later — it is the price of an append-only ledger, and the price is
right. The audit feed itself does not fall back: `events_list` serves the row as
it stands, because an audit feed that synthesises a field is no longer reporting
what is recorded.

## Consequences

`knowledge_changes` and `activity_digest` answer the same way for events written
before and after this decision. New events carry the facts where the contract says
they are, so a caller can ask for the revision an event produced without knowing
which key some older version of the code chose.

An installation that verifies its ledger sees no change: no stored event was
touched.

A reader of an old event through `events_list` still sees nulls in the four
columns and the values in `metadata`. That is what the row says, and the ledger's
job is to say what happened, not to make the past look like the present.
