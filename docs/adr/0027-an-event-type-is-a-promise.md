# 27. An event type is a promise

Date: 2026-09-27

Status: accepted

## Context

The ledger's event types are declared in `packages/contracts` and listed in
`DATA_MODEL.md` section 22. An audit of the enum against the code found four that
nothing has ever written:

- `sync.started`
- `sync.completed`
- `sync.expired`
- `summary.generated`

They were not forgotten in the sense of a missing line somewhere. Reconciliation
shipped in milestone 5 and summaries in milestone 8, both complete, both tested,
and neither wrote an event, because at each point there was nothing for the event
to record that the ledger is for.

A declared type nobody writes is worse than an absent one. An agent reading the
contract sees an audit feed that reports reconciliation and takes silence for
"no passes happened". The ledger screen built on the same enum offered a
**Reconciliation** filter that could never match a row — a filter whose only
possible answer is "nothing", presented as though it were an answer about the
workspace.

`summary.marked_stale` was removed for the same reason when ADR 0024 decided a
summary is stale by arithmetic. This is the general case of that decision.

## Decision

A type is in `EventType` only if something writes it. All four are removed, and
`sync_session` is removed from `ObjectType` with them, since no event is about
one any more.

**A reconciliation pass is not a material change.** Rule 4 admits only material
changes, and names successful authentications, per-candidate classifications and
job runs as things that are not. A pass reads the workspace, offers an inventory
and produces proposals. The proposals are material and each is already an event
carrying the session it came from. What `sync_complete` writes for itself is one
agent's checkpoint — private operational state of the same kind as a credential's
`last_used_at`, which section 22 already excludes by name. What happened in a pass
is answered by `sync_sessions` and its candidates, which is what the
reconciliation screen reads.

**Generating a summary is not a write.** `knowledge.draft_summary` runs a model
and returns text; nothing is recorded until a person saves it, and saving it is an
ordinary create or update with its own event, actor and commit. An event for the
draft would report a change that had not happened, and would double-count the one
that followed in any digest.

The ledger screen loses its **Reconciliation** group with the types it stood for.

## Consequences

The enum is now a description of what the ledger contains rather than of what it
was once imagined to contain, and the filter cannot offer a question the data
cannot answer. `knowledge.purged`, `attachment.uploaded`, `attachment.extracted`,
`webhook.changed` and `integrity.check_completed` stay: each belongs to a
milestone that is planned rather than built, and each will be written by the code
that builds it. Anything else added to the enum arrives with the code that writes
it, in the same change.

One thing this leaves unrecorded, and it was unrecorded before: that a model
phrased a body a person then saved. The browser shows "Drafted by <model>" while
the draft is on screen and the saved revision says nothing about it — the write
was made by the person, so the request's `model` provenance would be a false
statement about who wrote it, and a source is about where knowledge came from
rather than about who phrased it. Recording it needs a field of its own on the
revision or on a source, and a decision of its own. `summary.generated` never
recorded it either: it was never written.
