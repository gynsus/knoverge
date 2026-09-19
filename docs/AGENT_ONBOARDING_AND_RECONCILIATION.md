# Agent Onboarding and Reconciliation Protocol

## 1. Problem

A newly connected agent may already contain substantial information in:

- conversation memory;
- local project files;
- previous summaries;
- an IDE workspace;
- another memory system;
- exported notes;
- its own database.

Blindly uploading all of that information creates:

- duplicates;
- contradictory copies;
- stale knowledge;
- category fragmentation;
- excessive review work;
- unnecessary token usage.

Therefore onboarding is not an import operation.

It is a **reconciliation protocol**.

## 2. Goals

The protocol must:

1. let the agent understand the current knowledge structure;
2. avoid transferring full datasets when hashes/index metadata are enough;
3. detect exact duplicates cheaply;
4. detect likely semantic duplicates;
5. identify which side has newer information, only when lineage is known;
6. allow the agent to request missing categories;
7. fetch full canonical content only when needed;
8. submit only meaningful additions or updates;
9. checkpoint progress;
10. be resumable and idempotent.

## 3. Phase 0 - identity and permissions

An administrator creates an agent identity and credential.

Agent starts with a call to:

```text
workspace_manifest
```

The agent learns:

- workspace name and default language;
- supported knowledge types;
- taxonomy version;
- available capabilities;
- approximate workspace size;
- current `change_sequence`;
- onboarding recommendation.

```json
{
  "onboarding": {
    "required": true,
    "strategy": "reconcile",
    "reason": "Agent has no completed sync checkpoint for this namespace."
  }
}
```

## 4. Phase 1 - taxonomy discovery

Agent calls:

```text
taxonomy_list
```

with `include_item_counts` and, for large workspaces, `root_path` and `depth` to drill into branches, and `include_recent_key_items` to see what a branch contains. This is the knowledge map.

The response should be compact enough to fit in normal agent context.

Each category contains:

- id;
- path;
- description;
- inclusion guidance;
- exclusion guidance;
- item count and subtree count;
- updated timestamp;
- optionally recent key items.

The agent maps its local subjects to existing categories before proposing new categories.

## 5. Phase 2 - taxonomy negotiation

If the agent finds a stable subject that does not fit existing categories, it calls:

```text
taxonomy_propose
```

The default `propose` tier has this permission; creation still goes through policy or review.

The server checks:

1. exact names;
2. slugs;
3. aliases;
4. sibling categories;
5. optional semantic similarity.

Possible results:

### `use_existing`

Server has a sufficiently equivalent category.

### `proposal_created`

Human/taxonomy curator must review it.

### `created`

Agent policy permits immediate category creation.

The agent must not block the entire sync while a category proposal is pending. Candidates use the nearest existing parent category; once the new category exists, items can be recategorised through normal update proposals.

## 6. Phase 3 - begin sync session

Agent calls:

```text
sync_begin
```

Parameters identify the source namespace.

Examples:

```text
source_system = claude-code
source_namespace = github.com/example/project-x
```

or:

```text
source_system = chatgpt-export
source_namespace = personal-account
```

Server returns:

- `sync_session_id`;
- taxonomy version;
- `change_sequence`;
- previous checkpoint;
- recommended index slices;
- expiry.

## 7. Phase 4 - build local inventory

The agent creates a compact inventory of durable information it believes may belong in Knoverge.

It must not include every message or transient thought.

Each inventory record contains:

```text
client_candidate_id        required; unique within the session
title                      required
knowledge type             required
language                   optional
candidate category paths   optional
external_key               optional; stable id in the source system
source_content_hash        optional; fingerprint of the raw source
candidate_content_hash     optional; Knoverge-normalised hash of title + body
source_modified_at         optional
short abstract             recommended
external source locator    optional
```

### Client candidate id

Any stable string the agent can regenerate on retry, for example `c-000123` or a hash of the local path. It is the idempotency key inside the session. Not every memory has a natural external identity, so this field exists separately from `external_key`.

### External key

`external_key` should be stable for the source system.

Example:

```text
github.com/example/project-x:architecture/authentication
```

If the local source has a native immutable id, use it. Omit it when nothing stable exists (for example a preference inferred from a conversation).

### Two hashes

`source_content_hash` fingerprints the agent's raw source: file bytes, a message, a record. It answers "did my source change since last sync?".

`candidate_content_hash` is the hash of the knowledge as the agent would propose it, computed by the rules in `GIT_REPOSITORY.md` section 5 (normalised title + body). It answers "does Knoverge already hold this exact knowledge?". Clients that cannot compute SHA-256 reliably may omit it; matching then relies on lexical and semantic steps.

### Abstract

Use a small abstract intended for matching.

Do not send the full material during inventory.

Recommended maximum: 500-1000 characters.

## 8. Phase 5 - submit inventory for matching

Agent sends batches to:

```text
sync_submit_inventory
```

Recommended batch size: 50-200 records.

The server performs matching in this order.

### Step A - external identity (synchronous, final)

Match `source_system + external_key` against canonical items.

- found and `source_content_hash` unchanged since the last checkpoint: `exact_known`;
- found and changed: candidate for `server_copy_stale` (lineage is known), subject to Step F;
- not found: continue.

### Step B - content hash (synchronous)

Match `candidate_content_hash` against canonical `content_hash`.

- match with the same type and the same primary category: `exact_known`, final;
- match with a different type or category: `likely_match` with `match_reason = content_hash`, final. Identical text in a different scope may be a different piece of knowledge (the same instruction in two projects), so the agent must decide.

### Step C - title/category/type candidates (synchronous, provisional)

Use deterministic filters to reduce possible matches.

### Step D - lexical similarity (background job)

Use PostgreSQL FTS/trigram similarity with the candidate's language configuration.

### Step E - optional semantic similarity (background job)

If an embedding profile is active, use vector similarity over chunks.

### Step F - freshness (only with known lineage)

`agent_copy_stale` and `server_copy_stale` are assigned only when the two sides are known to be versions of the same lineage:

- same `source_system + external_key`; or
- a previous sync mapping for this `client_candidate_id` or external key.

Then compare `source_modified_at`, canonical `updated_at` and the previous checkpoint. Without lineage, wall-clock timestamps prove nothing (old text copied into a new file gets today's date), so the outcome is `likely_match` or `conflict`, never newer/stale.

The response to `sync_submit_inventory` returns Steps A-C immediately. Steps D-F refine `provisional` classifications; the agent polls `sync_get_matches` (or `sync_status`) until `pending_count` is zero.

## 9. Classification rules

### `exact_known`

Same external identity with unchanged source, or same content hash with compatible type and category.

Agent should skip.

### `likely_match`

A canonical item probably represents the same knowledge. `match_reason` says why.

Server returns candidate item ids and compact abstracts.

Agent should fetch those full items before changing anything.

### `new_candidate`

No meaningful canonical match exists.

Agent may propose creation.

### `conflict`

Both sides contain materially different current claims and neither can be safely treated as newer.

Agent should fetch canonical item and submit a proposal that explicitly describes the conflict.

Do not silently overwrite.

### `agent_copy_stale`

Known lineage, canonical information is newer than the agent's information.

Agent should not propose the old data.

If useful, the agent may update its own local state.

### `server_copy_stale`

Known lineage, the agent has a newer version.

Agent should fetch canonical content and propose an update using the canonical base revision/hash.

### `ambiguous`

Several canonical items are plausible.

Agent should retrieve candidates and decide.

### `ignored`

Server policy says this material should not become durable knowledge.

## 10. Phase 6 - targeted canonical reads

The agent fetches full canonical content only for:

- likely matches;
- conflicts;
- server-stale items;
- ambiguous matches;
- records requiring context.

This is the main context-saving mechanism.

The agent should compare:

```text
its local source
vs
canonical current revision
vs
relevant provenance/history when needed
```

## 11. Phase 7 - submit only deltas

### New material

Use:

```text
knowledge_propose_create
```

Pass `sync_session_id` so reviewers can filter by import run. The duplicate check still runs; `likely_match` candidates the agent decided are distinct must be passed as `acknowledged_duplicate_ids`.

Respect the granularity rule: one item per independently updateable assertion. Do not upload a whole notes file as one `fact`.

### Updated material

Use:

```text
knowledge_propose_update
```

Always include canonical:

```text
base_revision_id
base_content_hash
```

### Replaced material

If the canonical statement was true and is now replaced, use `knowledge_propose_supersede` so history and validity are preserved atomically.

### Contradictory material

Do not replace a canonical statement merely because the agent disagrees.

Submit a new item with evidence/source, an explanation, and a `contradicts` relation, or an update proposal if appropriate.

## 12. Phase 8 - review

Proposals may be:

- committed directly by policy;
- queued for human review;
- queued for trusted curator review.

The agent does not need to remain connected while proposals are reviewed. It can check outcomes later with `proposal_list` / `proposal_get`.

## 13. Phase 9 - complete checkpoint

After all inventory candidates have terminal classifications or proposals, call:

```text
sync_complete
```

Persist:

- taxonomy version;
- `change_sequence`;
- processed candidate ids, external keys and hashes;
- counts;
- completion time.

## 14. Incremental future sync

A previously synced agent should not repeat a full reconciliation.

On future connection:

1. call `workspace_manifest`;
2. compare taxonomy version;
3. call `knowledge_changes` with `after_sequence = last_change_sequence`; this returns every canonical change in the agent's readable scope regardless of who made it;
4. update local mapping;
5. reconcile only local records changed since `last_completed_at`.

`events_list` is the audit feed and is not used for synchronisation.

Full rescan should be optional.

## 15. Session start for a working agent

Onboarding is about pushing knowledge in. Most sessions are about pulling it out.

A working agent (for example Claude Code opening a project) should:

1. call `workspace_manifest`;
2. call `knowledge_briefing` for the project subtree;
3. optionally call `knowledge_changes` since its last stored `change_sequence`;
4. work;
5. propose deltas with the revision ids and content hashes from the briefing.

## 16. Recommended agent algorithm

```text
GET manifest

IF no checkpoint:
    GET taxonomy (as knowledge map)

    map local subject areas to categories

    FOR each missing stable category:
        propose category

    BEGIN sync

    build local durable inventory

    SUBMIT inventory in batches
    POLL matches until no provisional classifications remain

    FOR each candidate:
        IF exact_known:
            skip

        IF agent_copy_stale:
            skip local upload

        IF likely_match OR ambiguous OR conflict OR server_copy_stale:
            fetch canonical item
            compare
            propose only meaningful delta (update or supersede)

        IF new_candidate:
            propose create

    COMPLETE sync

ELSE:
    GET knowledge_changes since saved change_sequence
    reconcile only locally changed information
    save new checkpoint
```

## 17. Idempotency

A repeated sync batch must not create duplicate candidates.

Use:

```text
sync_session_id + client_candidate_id
```

as the unique key inside the session.

Knowledge proposals additionally use client idempotency keys.

## 18. Failure recovery

Sync sessions may be resumed until expiration.

Agent can call `sync_status` and continue from the last accepted candidate batch.

A failed sync must not leave half-created canonical knowledge without corresponding audit records.

## 19. Security

An agent may only receive taxonomy/index/items/changes within its authorised scope.

Reconciliation must not become a way to enumerate restricted categories.

## 20. Human UX

The web UI should show an onboarding run as:

```text
Agent: Claude Code - Project X

Local candidates:       1,284
Exact known:               932
Server newer:               81
Likely matches:            104
New proposals:              92
Conflicts:                  13
Ambiguous:                  62
```

Reviewers should be able to filter proposals by:

- agent;
- category;
- type;
- confidence;
- conflict status;
- import/sync session.
