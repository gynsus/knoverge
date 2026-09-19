# ADR 0010: Knowledge change feed separate from the audit feed

- Status: Accepted
- Date: 2026-09-19

## Context

The reconciliation protocol told agents to learn what changed since their last checkpoint by reading events. The default agent permission was `events.read_own`, which returns only the agent's own events. An agent therefore never saw changes made by other agents or humans, which breaks incremental synchronisation for a shared knowledge system.

Using audit events for synchronisation also leaks actor information that a synchronising agent does not need, and ties a read-scope question to an audit-scope permission.

The first draft also proposed ULID event ids as cursors; ULIDs created in the same millisecond are not ordered by commit order.

## Decision

1. Two feeds are derived from the single event ledger:
   - **audit feed** `events_list`: all events, gated by `events.read_own` / `events.read_all`, exposes actors;
   - **knowledge change feed** `knowledge_changes`: only knowledge, relation and taxonomy changes, gated by the caller's `knowledge.read` scope, exposes no actors.
2. Each event stores a snapshot of the affected item's category ids so the change feed can be filtered by scope without joining current state. Items that leave the caller's scope appear as `deleted`, items that enter it as `created`.
3. Cursors are the per-workspace, gapless integer `sequence` of the ledger. Clients pass `after_sequence`. Object ids are never cursors.
4. `workspace_manifest`, `knowledge_briefing`, `sync_begin` and `sync_complete` expose or persist `change_sequence`; `events_list` uses `event_sequence`. Both are positions in the same sequence; the names document intent.

## Consequences

### Positive

- Incremental sync works for every agent with read access.
- No second table: the change feed is a filtered projection of the ledger.
- Cursors are exact and total-ordered.

### Negative

- Events grow by a category id snapshot.
- Scope filtering is evaluated per read, which is acceptable at expected volumes and indexable by `(workspace_id, sequence)`.

## Rejected alternatives

### Grant `events.read_all` to synchronising agents

Would expose the full audit trail, including other actors' behaviour, to every agent. Rejected.

### Separate change table

Duplicates ledger content and needs its own consistency guarantees. Rejected.
