# ADR 0007: Keyed hash-chained event ledger

- Status: Accepted
- Date: 2026-09-19 (revised the same day after review)

## Context

The event ledger is append-only by application rule, but nothing made tampering detectable. A product that calls itself a ledger should let an operator verify that history has not been altered after the fact.

A plain `SHA-256(prev_hash || event)` chain detects accidental corruption, deleted rows and partial edits, but not a party with write access to PostgreSQL who edits an event and recomputes every later hash. The first draft of this ADR overstated what such a chain provides.

The first draft also allowed knowledge text in event payloads, which is incompatible with a later purge feature: redacting a payload would change its hash and force a chain rewrite.

## Decision

### Chain

1. Each workspace has a monotonic, gapless `sequence` for events.
2. Each event stores `prev_event_hash` and `event_hash`, where

   ```text
   event_hash = HMAC-SHA256(KNOVERGE_LEDGER_KEY, prev_event_hash || canonical_json(event))
   ```

   `canonical_json` is RFC 8785 (JSON Canonicalization Scheme) over an explicit, versioned field list, not over whatever columns the table happens to have. Each event stores the `hash_version` it was written with, so adding a column later cannot change the hash of events already written, and a future field set is a new version that old events keep verifying against. Timestamps are RFC 3339 UTC and absent values are `null`; values that are `undefined` are dropped before hashing, so what is hashed matches what the database stores. The first event of a workspace uses `prev_event_hash = HMAC-SHA256(KNOVERGE_LEDGER_KEY, "")`.
3. `KNOVERGE_LEDGER_KEY` is a required secret supplied through the environment. It is never stored in PostgreSQL. The integrity checker needs it to verify; backups of the key are the operator's responsibility and are documented with the other secrets.
4. Events are inserted inside the same transaction as the domain change, holding a per-workspace advisory lock so that `sequence` and the chain cannot fork.
5. `knoverge ledger verify` recomputes the chain and reports the first broken link. It becomes part of the wider `knoverge integrity check` once the Git store exists.

### What the chain guarantees

- Detects modification, reordering, insertion or deletion of events by anyone who does not possess `KNOVERGE_LEDGER_KEY`. This covers a compromised database, a leaked database backup, and direct SQL edits by a database administrator.
- Does **not** protect against an attacker who controls the application host, since the key is available there. External anchoring or signing could address that later and is out of scope.
- Key rotation: a new key applies from a recorded `sequence` onward; the checker takes a list of `(from_sequence, key)` pairs. Old keys must be kept to verify old ranges.

### Event content rule

6. An event never contains knowledge text, proposal payloads, credentials, session tokens or other secrets. It contains identifiers, content hashes, actor context, category id snapshots and safe metadata such as counts and decision codes.
7. Consequently a purge (later milestone) rewrites Git history, redacts `Proposal.proposed_payload_json`, and rebuilds search and embedding projections, while the ledger is untouched. The purge itself is a new `knowledge.purged` event.

### Ledger scope

8. Only material, auditable changes are ledger events: knowledge, relations, taxonomy, proposals and decisions, permissions and policy, agent lifecycle and credentials, sync session start/complete, summaries, attachments, integrity runs, denied commands.
9. High-volume operational facts (successful authentication, per-candidate sync classification, searches, job runs) are not ledger events. They live in logs and in their own tables.

### Derived feeds

10. `events_list` exposes the ledger as the audit feed, gated by `events.read_own` / `events.read_all`.
11. `knowledge_changes` exposes a filtered projection of knowledge, relation and taxonomy events, gated by the caller's `knowledge.read` scope using the category id snapshot stored on each event. Both feeds use `sequence` as cursor. See ADR 0010.

## Consequences

### Positive

- Honest, well-defined tamper evidence for the realistic threat of database compromise.
- Purge remains possible without breaking immutability.
- Low contention: only material events are serialised.
- One ledger serves both audit and synchronisation.

### Negative

- One more required secret; losing it makes historical verification impossible (the data itself is unaffected).
- Event inserts for one workspace are serialised; acceptable at expected write rates.

## Rejected alternatives

### Plain SHA-256 chain

Cheaper, but its guarantee is limited to accidental corruption. Rejected because the keyed variant costs the same and covers the database-compromise case.

### External timestamping or signing

Stronger, but introduces key management and external services. Deferred.

### Separate encrypted payload table for redactable audit details

Allows richer events, but adds a second store and key handling. Rejected in favour of the rule that events carry no redactable content.
