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

### Duplicate check

`knowledge_propose_create` runs the same matcher used by reconciliation (external key, content hash, lexical, optional semantic) before creating a proposal.

If a probable duplicate is found and the caller did not acknowledge it, the server returns `DUPLICATE_SUSPECTED` with the candidate items and creates nothing. The caller either:

- updates the existing item instead;
- or repeats the call with `acknowledged_duplicate_ids`, which is recorded on the proposal for reviewers.

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

Reviewers may be humans (web UI, HTTP) or agents with `knowledge.approve` (MCP `proposal_approve`). An actor never approves its own proposal.

Approval by a human sets `review = human_reviewed` on the resulting revision; approval by an agent sets `agent_reviewed`; a direct commit leaves `unreviewed` unless the committer is a human.

## 5. Supersession

Use supersession when:

- a fact changed over time;
- a newer decision replaces an older decision;
- an instruction was intentionally replaced.

Do not erase historical content.

Supersession is one atomic operation, `knowledge_propose_supersede`, producing one commit and two revisions:

```text
new_item supersedes old_item      (relation, mirrored in both frontmatters)
old_item.status = superseded
old_item.valid_until = <date>
new_item.valid_from = <date>
```

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
