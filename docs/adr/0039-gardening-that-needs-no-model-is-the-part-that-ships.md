# 39. Gardening that needs no model is the part that ships

Date: 2026-10-09

Status: accepted

## Context

Milestone 14 is the last one in the plan, and it has been waiting on a question
rather than on code. Its list reads:

> duplicate detection; merge suggestions; taxonomy cleanup; stale instruction
> detection; contradiction detection; orphan source detection; weak-provenance
> detection.

Rule 9 says the core must run without an LLM, and names what has to keep
working without one. Most of that list, read quickly, sounds like it needs a
model. If that reading were right, Milestone 14 would be the first milestone
that cannot be built without a provider — and the rule would have to bend or
the milestone would have to shrink.

The reading is wrong, and the codebase already shows why. Reconciliation
classifies a candidate by `MatchReason`, which is one of `external_key`,
`content_hash`, `lexical`, `semantic` or `none`. Three of those five need
nothing but the database. "Is this the same thing" has had a deterministic
answer here since Milestone 5; what a model adds is reach, not the answer.

## Decision

**Gardening splits by what a finding rests on, not by how clever it sounds.**

A job belongs to the core when its finding can be computed from what the
database and the repository already record. A job belongs to the optional layer
when its finding rests on a judgement about meaning.

**In the core, with no provider configured:**

- **Duplicates by hash and by text.** Two items whose content hash matches are
  the same item twice. Two items whose titles and normalised text match
  lexically are a candidate pair. This is the `content_hash` and `lexical` half
  of what reconciliation already does, pointed inward at one workspace instead
  of outward at an arriving agent.
- **Orphan sources.** A source reference nothing rests on any more, and an
  attachment whose `document` item was deleted. Both are joins.
- **Weak provenance.** An item whose revisions cite nothing, in a workspace
  where most items cite something. The threshold is a count, not an opinion.
- **Stale instructions.** An `instruction` or `decision` past its `valid_until`,
  or one whose `valid_from` is old and which nothing has touched since. The
  dates are in the row.
- **Taxonomy cleanup.** A category holding no items and no children, and an
  alias pointing at a category that no longer exists. `itemCounts` already
  answers the first.
- **Stale summaries.** A summary whose dependencies have moved. The dependency
  rows already say so; this is the gardener noticing rather than a reader
  finding out.

**In the optional layer, only with a provider:**

- **Duplicates by meaning.** The `semantic` match reason, over embeddings.
- **Merge suggestions.** What two near-identical items should become is a draft,
  and a draft is writing.
- **Contradictions.** Whether two claims disagree is a reading of both.

**Every gardening finding is a proposal, and nothing else.** Rule 5 says agents
propose; a job that runs on a schedule and answers to nobody has less claim to
write than an agent a person connected on purpose. The gardener gets no
`allow_direct` path, and no policy rule can give it one — not because the policy
could not express it, but because there is no actor on the other end to hold
responsible for the result.

**A gardening proposal says what it rested on.** A finding that cannot name its
evidence is an opinion with a queue position. Every proposal carries the rule
that produced it and the rows it read, so a reviewer can disagree with the rule
rather than with the finding.

**Nothing is deleted, and nothing is merged.** The strongest action gardening
can propose is a supersession, which is already a reviewed operation with both
ends recorded. A gardener that could merge would be a gardener that could lose
the distinction between two things somebody meant to keep apart.

## Consequences

Milestone 14 is buildable today, without an AI provider, and the half that needs
one is an addition rather than a prerequisite. Rule 9 holds without being bent,
and the milestone does not shrink: what moves to the optional layer is three
jobs out of nine, and each of the three is one a person would want to read
anyway.

The core half reuses machinery that exists. Hash and lexical matching, item
counts, summary dependency state and source joins are all built and tested; the
gardener is a reader of them on a schedule, not a new subsystem. That is the
difference between this milestone and the ones before it, and it is why it can
follow a release rather than needing one.

A workspace that has never had a provider will see fewer findings than one that
has. That is honest and visible rather than hidden: the screen says which rules
ran, and a rule that needs a model says so when no model is assigned, the way
the AI settings already report what is and is not configured.

The queue can be flooded. Six rules over a large workspace could produce more
proposals than anybody will read, which would make the review queue useless for
the proposals that came from people and agents. So gardening findings are capped
per run and per rule, the cap is an operator setting, and a rule that would
exceed it reports the count rather than filing the rest. A gardener that buries
the queue has done harm, not work.

## Rejected alternatives

### Build the whole milestone on a provider and mark it optional

The simplest reading of the list, and the one that would have made the milestone
one subsystem instead of two. Rejected because "optional" would then mean the
feature does not exist for an installation that configured nothing, while the
plan and the README both say gardening is part of the product. A feature that is
absent without a provider is a provider feature, whatever the heading says.

### Deterministic rules only, and never a semantic half

Tempting, because it keeps one rule set and one code path. Rejected because
duplicates by meaning are the ones a person cannot find by searching — the pair
that says the same thing in different words is exactly what gardening is for,
and refusing to look for it to preserve a tidy boundary would be refusing the
useful half of the job.

### Let a trusted gardener write directly

A workspace that trusts its agents might reasonably want tidying to happen
rather than to queue. Rejected on rule 5 and on who answers for it: an agent's
writes are attributable to an identity somebody created and can revoke, while a
scheduled job is attributable to the installation. The ledger would record the
system actor rewriting knowledge, and nobody could say why it was allowed to.
