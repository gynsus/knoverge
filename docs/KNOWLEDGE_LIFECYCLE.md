# Knowledge Lifecycle

## 1. Purpose

This document defines how knowledge enters, changes, becomes disputed, is superseded, and is removed from the active view.

## 2. Create path

Default agent path:

```text
candidate
→ permission check (FORBIDDEN if absent)
→ duplicate check
→ policy: deny | allow_direct | require_review
     deny          → no proposal, command.denied event, FORBIDDEN
     require_review→ pending proposal
     allow_direct  → proposal recorded as approved by system
→ review (if required)
→ canonical revision 1 (Git commit + PostgreSQL)
→ projections (search chunks, embeddings)
→ event
```

A direct-write agent still passes through the same domain validation, duplicate check and audit pipeline; only the human review step is skipped. Without an explicit `allow_direct` rule every agent write requires review.

Proposals must respect the granularity rule (`KNOWLEDGE_MODEL.md` section 2a). Reviewers may split an oversized proposal through edit-and-approve.

A pending proposal is checked for what would stop it being applied — the categories it names and the items its relations point at — before it is recorded, so that a reviewer is never handed something that can only fail on approval.

`knowledge_propose_create` accepts an idempotency key. A retry after a dropped connection replays the first answer rather than leaving a second proposal in the inbox, or a second item when policy allowed the write directly.

### Retention of the proposed text

A proposal row is the only place outside Git that holds proposed knowledge, including text a reviewer rejected. Maintenance empties the payload of a proposal resolved more than 90 days ago and keeps the row: who proposed what kind of change, when, how policy decided, who resolved it and what came of it stay for as long as the workspace does.

### Duplicate check

`knowledge_propose_create` runs the same matcher used by reconciliation (external key, content hash, lexical, optional semantic) before creating a proposal.

If a probable duplicate is found and the caller did not acknowledge it, the server returns `DUPLICATE_SUSPECTED` with the candidate items and creates nothing. The caller either:

- updates the existing item instead;
- or repeats the call with `acknowledged_duplicate_ids`, which is recorded on the proposal for reviewers.

Each candidate carries a `match_reason`. `exact` is the same text under the same type and the same primary category, and cannot be acknowledged away: saying "this is not a duplicate" about the same text in the same place is not a judgement anybody should be able to make, and the caller wants to change that item. `content_hash` is the same text somewhere else, which may well be a different piece of knowledge — the same instruction in two projects is two instructions. `lexical` is a title close enough to be worth reading, by trigram similarity at 0.6 or above; PostgreSQL's own default of 0.3 pairs unrelated short titles, and a check that cries wolf gets acknowledged without being read. `semantic` is a passage that says nearly the same thing without sharing the words, at cosine similarity 0.88 or above — offered only when an embedding provider is configured, because the check has to work without one (rule 9).

That threshold is deliberately high and deliberately unmeasured. Tuning it needs a corpus, a model and somebody's judgement about pairs; until all three exist the conservative number is the honest one, because a false positive refuses a write somebody meant to make and the only way past it is acknowledging a candidate that was never a duplicate — which teaches a proposer to acknowledge everything. A missed one is caught by the same check on approval, and by a reviewer reading the text.

The check runs before policy's answer matters, so a write that would have gone through directly is stopped by it too. It looks only at active items: a deleted or superseded item saying the same thing is history, and pointing a proposer at what was already replaced would send them the wrong way.

An item under an external identity the workspace already holds is `DUPLICATE_EXTERNAL_KEY`, which is final. Two records under one external key are the same record.

Semantic similarity is the one step that needs an embedding profile and arrives with it. Rule 9 holds: the check works without any AI provider.

The check runs twice, like the base check on an update. A proposal waits, and the workspace can gain the item while it does — through a direct write, or through an identical proposal approved first. Approval re-runs the `exact` and external-identity halves; a close title is not raised again, because that is a question for the proposer and the reviewer is reading the text in front of them. A proposal that fails the second check becomes `conflict`, for the same reason a stale one does.

## 3. Update path

An update proposal must identify the revision it was based on.

```text
canonical rev 7
      ↓ agent reads
proposal based on rev 7
      ↓
canonical changes to rev 8
      ↓
old proposal cannot overwrite rev 8
```

The old proposal becomes:

```text
conflict
```

The agent/human must rebase.

Several pending proposals may target the same item. The first approved one wins; the others become `conflict` and the reviewer can rebase them in the UI.

The base is checked twice. A proposal written against a revision that is no longer current is refused when it is made, so the proposer is told now rather than after a reviewer has spent attention on it. It is checked again on approval, because the item can move on while the proposal waits — a direct write, or another proposal approved first. A proposal that fails the second check becomes `conflict` rather than staying pending: it must not go back into the inbox to fail the same way for the next reviewer.

`conflict` is not `rejected`. Nobody decided against the proposal, and the difference matters to whoever wrote it.

## 4. Review outcomes

### Approve

Proposed payload becomes canonical.

### Edit and approve

Reviewer modifies proposed payload.

Event ledger must record:

- original proposer;
- reviewer;
- original proposal;
- final committed revision.

### Reject

Proposal remains in audit history.

A rejection reason is recommended.

### Mark conflict

Use when the proposal exposes an unresolved contradiction.

### Withdraw

The proposer/system may withdraw a proposal that is no longer relevant.

Reviewers may be humans (web UI, HTTP) or agents with `knowledge.approve` (MCP `proposal_approve`). An actor never approves its own proposal, and the same actor may not reject one either: review is a second pair of eyes or it is nothing.

The reviewer is the actor of the resulting write. They are who made it canonical, and the commit carries `Knoverge-Proposal`, so the repository alone leads from the file back to the decision and from there to the proposer. A reviewer who changed the text before approving has the changed text stored on the proposal as well, because a trail claiming the proposer wrote words they never saw is worse than no trail.

Withdrawing is the proposer's own act and needs no permission. Anybody else withdrawing somebody else's proposal is a reviewer's act and requires `knowledge.approve`: an inbox nobody can clear is an inbox nobody reads.

A proposal that is no longer `pending` answers `PROPOSAL_ALREADY_RESOLVED` to every further decision. `proposal_approve` accepts an idempotency key, so a retry that arrives before the first call has finished writing replays it rather than producing a second item.

Approval by a human sets `review = human_reviewed` on the resulting revision; approval by an agent sets `agent_reviewed`; a direct commit leaves `unreviewed` unless the committer is a human.

## 5. Supersession

Use supersession when:

- a fact changed over time;
- a newer decision replaces an older decision;
- an instruction was intentionally replaced.

Do not erase historical content.

Supersession is one atomic operation, `knowledge_propose_supersede`, producing one commit and two revisions:

```text
new_item supersedes old_item      (one relation, on the new item)
old_item.superseded_by = new_item (projection of it, on the old item)
old_item.status = superseded
old_item.valid_until = <date>
new_item.valid_from = <date>
```

The relation is recorded once and written twice, in different forms. PostgreSQL and the new item's `relations` list hold `new supersedes old`; the old item's frontmatter carries `superseded_by` instead, so a file read on its own says both that it was replaced and by what without a second relation row to disagree with the first. ADR 0015 records why.

A half-applied supersession (relation without status change, or the reverse) cannot exist.

## 6. Contradictions

Contradiction is not always error.

Two sources may disagree.

Represent:

```text
A contradicts B
```

Both items keep their lifecycle status and their review and evidence state. Their `disputed` flag becomes true until a human resolves the contradiction by supersession, rejection, or explicit acceptance of both with temporal validity, after which the flag clears.

Contradictions are expressed through the `relations` list of `knowledge_propose_create` or `knowledge_propose_update`.

Do not let an LLM automatically delete one side merely due to confidence.

### How the flag gets there

`disputed` is derived and nothing sets it (ADR 0022):

```text
disputed(X) = a live `contradicts` relation connects X to Y, either direction,
              and Y is active, and the validity windows of X and Y overlap
```

The relation is recorded once, on the item that reported the contradiction, and
written twice: that item carries it in `relations`, and the item it names gains
`disputed_by` in its frontmatter. So both files say they are disputed, and both
say by what, without a second relation row to disagree with the first.

Marking the other item changes its file, so it is a new revision and part of the
same commit — one commit, two revisions, like a supersession. Five operations
can move a verdict, because five of them can change a relation, a status or a
validity window: `create`, `update`, `supersede`, `delete` and `restore`. Each
writes the other items it marks or unmarks into its own commit.

Every resolution this section names falls out of the rule rather than needing an
operation of its own:

| Resolution | Why the flag clears |
| --- | --- |
| Supersession | The superseded side is no longer `active`. |
| Rejection | The relation was never recorded. |
| Accepting both with temporal validity | The windows no longer overlap, so the two claims were never true at once. |
| Withdrawing the relation | The contradiction was reported in error. |

A deleted item is never disputed: it is out of the active answer either way, and
its relations are kept, so a restore reopens the dispute rather than losing it.

## 7. Delete

Deletion means remove from normal active retrieval.

Requirements:

- explicit delete proposal unless policy allows direct delete;
- reason;
- audit event;
- file removed from the repository tree in a commit; previous revisions remain in Git history;
- authorised restore is possible and produces a new revision.

Physical purge (removing secrets or personal data) is a later admin feature. It rewrites Git history, redacts `Proposal.proposed_payload_json`, and rebuilds search and embedding projections. The event ledger is untouched because events never contain knowledge text; the purge itself is recorded as a `knowledge.purged` event.

## 8. Manual editing

A human may edit canonical content through the web UI.

The UI must still create:

- new revision;
- Git commit;
- event ledger entry.

It creates no proposal. A proposal exists so that somebody can decide, and a
person writing through the UI has already decided; recording one per edit would
fill the review inbox with items nobody has to look at, and would put the same
knowledge text in a second place outside Git. Who wrote what, when and on what
authority is on the revision, the commit and the ledger entry, which is what
rule 3 asks for. An agent is the other case: it proposes, and section 2 is how
that is decided.

Direct filesystem editing of the workspace repository is unsupported in MVP. See `GIT_REPOSITORY.md` section 9.

## 9. Derived summaries

A summary records revision dependencies.

When a dependency receives a new current revision:

```text
summary.stale = true
```

The old summary remains readable with its generation timestamp.

Regeneration produces a new summary revision according to policy.

## 10. Knowledge quality

Future knowledge-gardening jobs may suggest:

- duplicate merge;
- category cleanup;
- stale instructions;
- contradictions;
- missing sources;
- orphan items.

These jobs must create proposals, not silently rewrite canonical content, unless explicitly authorised.
