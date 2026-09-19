# MCP API

## 1. Purpose

MCP is the main interface used by AI agents.

The MCP surface must remain compact, stable, and domain-oriented.

Avoid exposing database-shaped tools.

Every tool below is also available over HTTP as `POST /v1/<tool_name>` with the same input and output schemas. See `HTTP_API.md` and ADR 0003.

## 2. Naming

Tool names use `^[a-z][a-z0-9_]*$` so they are accepted by every MCP host and by OpenAI-compatible function calling. Dots are not used.

## 3. Transport and authentication

Remote MCP uses the Streamable HTTP transport at `/mcp`.

MVP authentication is a per-agent bearer token:

```text
Authorization: Bearer knv_<prefix>_<secret>
```

The server resolves the credential to:

```text
workspace
actor
agent identity
trust tier
permissions and scopes
```

OAuth 2.1 (authorization server with dynamic client registration) is a later milestone for hosts such as ChatGPT and Claude.ai connectors. See ADR 0004.

The `knoverge mcp stdio` command runs a local stdio bridge that forwards to the remote endpoint with a token from the environment.

## 4. Context metadata

Where the client supports it, requests should carry:

```json
{
  "session_id": "optional-client-session",
  "provider": "anthropic",
  "model": "claude-...",
  "client": "claude-code",
  "request_id": "uuid"
}
```

Over MCP these travel in the request `_meta` field; over HTTP in headers (`HTTP_API.md`). The server must function if provider/model are unavailable and generates `request_id` when absent.

## 5. Cursors

Two monotonic per-workspace sequences are exposed:

- `change_sequence`: position in the knowledge change feed;
- `event_sequence`: position in the audit feed.

Both are integers. Clients store them as checkpoints and pass them back as `after_sequence`. Object ids are never used as cursors.

## 6. Category paths in the contract

Every tool accepts and returns categories as slug paths (`projects/pixel-brisbane/architecture`). The server resolves paths to stable ids internally; authorisation is always evaluated against ids.

## 7. Tool set

### Workspace and taxonomy

#### `workspace_manifest`

Returns a compact description of the workspace.

Use this as the first call when an agent has no current workspace context.

Input:

```json
{}
```

Output:

```json
{
  "server": { "name": "knoverge", "version": "0.1.0", "contract_version": "1" },
  "workspace": { "id": "ws_01J...", "name": "Personal Knowledge", "default_language": "en" },
  "taxonomy_version": 42,
  "change_sequence": 18734,
  "event_sequence": 22010,
  "knowledge_types": ["fact", "decision", "instruction", "preference", "procedure", "observation", "episode", "document", "insight", "summary"],
  "capabilities": {
    "can_read": true,
    "can_propose": true,
    "can_propose_taxonomy": true,
    "can_write_direct": false,
    "can_approve": false,
    "can_manage_taxonomy": false,
    "semantic_search": true
  },
  "stats": { "items": 5821, "categories": 38, "pending_proposals": 14 },
  "onboarding": {
    "required": true,
    "strategy": "reconcile",
    "reason": "Agent has no completed sync checkpoint for this namespace."
  }
}
```

`can_write_direct` is true only if at least one policy rule grants `allow_direct` to this actor.

#### `taxonomy_list`

Returns compact category structure. With the optional flags it doubles as the hierarchical knowledge map.

Input:

```json
{
  "root_path": null,
  "depth": null,
  "include_archived": false,
  "include_guidance": true,
  "include_item_counts": true,
  "include_recent_key_items": false,
  "recent_key_items_limit": 5
}
```

Output per category:

```json
{
  "id": "cat_01J...",
  "path": "projects/pixel-brisbane/architecture",
  "name": "Architecture",
  "description": "...",
  "inclusion_guidance": [],
  "exclusion_guidance": [],
  "item_count": 51,
  "subtree_item_count": 51,
  "updated_at": "...",
  "recent_key_items": [
    { "item_id": "kn_...", "title": "Authentication strategy", "type": "decision", "updated_at": "..." }
  ]
}
```

Only categories readable by the caller are returned.

#### `taxonomy_propose`

Proposes a new category. Available to the default `propose` tier.

Input:

```json
{
  "name": "Data Sources",
  "parent_path": "projects/home-heads-up",
  "description": "External and internal data sources.",
  "reason": "Existing categories do not distinguish source ownership and refresh rules.",
  "example_titles": ["BOM weather source", "Council collection source"],
  "idempotency_key": "..."
}
```

Output `result` is one of:

```text
use_existing      (returns category id/path and explanation)
proposal_created  (returns proposal id)
created           (returns category id/path)
```

### Reading knowledge

#### `knowledge_search`

Input:

```json
{
  "query": "authentication architecture",
  "category_paths": [],
  "types": [],
  "statuses": ["active"],
  "languages": [],
  "review_states": [],
  "include_disputed": true,
  "limit": 20,
  "include_snippets": true
}
```

Result cards contain:

```text
item id
title
type
category paths
status
review_state, evidence_state, disputed
language
updated_at
current revision id / content hash
score and score components when useful
best matching chunk (index, snippet)
```

#### `knowledge_get`

Input:

```json
{
  "item_id": "kn_01J...",
  "revision_id": null,
  "include_provenance": true,
  "include_relations": true,
  "max_chars": 20000,
  "offset": 0
}
```

Returns canonical Markdown plus metadata. When the body exceeds `max_chars`, the response contains the slice starting at `offset`, `total_chars`, and `truncated: true`. Default `max_chars` is 20000.

#### `knowledge_index`

Returns compact index pages for reconciliation.

Input:

```json
{
  "category_paths": [],
  "updated_after": null,
  "cursor": null,
  "limit": 500
}
```

Index record:

```json
{
  "item_id": "kn_01J...",
  "title": "Authentication strategy",
  "type": "decision",
  "category_paths": ["projects/pixel-brisbane/architecture"],
  "status": "active",
  "review_state": "human_reviewed",
  "evidence_state": "source_backed",
  "disputed": false,
  "language": "en",
  "revision_id": "rev_01J...",
  "content_hash": "sha256:...",
  "source_system": "claude-code",
  "external_key": "project-x/decision/auth",
  "updated_at": "...",
  "abstract": "Short canonical abstract suitable for matching."
}
```

The abstract is intentionally short.

#### `knowledge_briefing`

Returns a compact, token-budgeted context pack for a category subtree. Intended as the first substantive call of a working session.

Input:

```json
{
  "category_paths": ["projects/pixel-brisbane"],
  "types": ["instruction", "preference", "decision", "procedure"],
  "include_recent": true,
  "recent_days": 14,
  "max_chars": 24000
}
```

Output:

```json
{
  "taxonomy_version": 42,
  "change_sequence": 18734,
  "sections": [
    {
      "kind": "instructions",
      "items": [
        { "item_id": "kn_...", "title": "...", "revision_id": "rev_...", "content_hash": "sha256:...", "markdown": "full or abridged", "abridged": false }
      ]
    },
    { "kind": "preferences", "items": [] },
    { "kind": "decisions", "items": [] },
    { "kind": "recent", "items": [ { "item_id": "kn_...", "title": "...", "type": "observation", "updated_at": "..." } ] },
    { "kind": "open_conflicts", "items": [] },
    { "kind": "pending_proposals", "items": [] }
  ],
  "truncated": false
}
```

Ordering inside a section: computed trust score (review, evidence, dispute), then freshness. When the budget is exceeded, items are abridged (first paragraph) before being dropped, and `truncated` is set.

#### `knowledge_history`

Input:

```json
{ "item_id": "kn_01J...", "limit": 50, "cursor": null }
```

#### `knowledge_diff`

Input:

```json
{ "item_id": "kn_01J...", "from_revision_id": "rev_...", "to_revision_id": "rev_..." }
```

#### `knowledge_changes`

The incremental synchronisation primitive. Returns canonical knowledge changes after a checkpoint, limited to what the caller may read. Requires only `knowledge.read`.

Input:

```json
{ "after_sequence": 18734, "category_paths": [], "types": [], "limit": 200 }
```

Output:

```json
{
  "changes": [
    {
      "sequence": 18735,
      "change_kind": "updated",
      "item_id": "kn_...",
      "revision_id": "rev_...",
      "content_hash": "sha256:...",
      "frontmatter_hash": "sha256:...",
      "category_paths_before": ["projects/x"],
      "category_paths_after": ["projects/y"],
      "taxonomy_version": 43,
      "changed_at": "..."
    }
  ],
  "next_sequence": 18790,
  "has_more": false,
  "taxonomy_version": 43
}
```

`change_kind` is one of `created`, `updated`, `moved`, `superseded`, `deleted`, `restored`, `relation_changed`, `taxonomy_changed`. Items that left the caller's readable scope appear as `deleted` from the caller's point of view; items that entered it appear as `created`.

This feed does not reveal who made a change. That is the audit feed.

### Proposing changes

#### `knowledge_propose_create`

Input:

```json
{
  "title": "Authentication strategy",
  "type": "decision",
  "language": "en",
  "category_paths": ["projects/pixel-brisbane/architecture"],
  "tags": ["auth"],
  "markdown": "...",
  "source_refs": [],
  "relations": [ { "type": "contradicts", "target": "kn_..." } ],
  "reason": "New durable project decision.",
  "confidence": 0.95,
  "external_ref": {
    "source_system": "claude-code",
    "external_key": "project-x/decision/auth",
    "source_modified_at": "...",
    "source_content_hash": "sha256:..."
  },
  "acknowledged_duplicate_ids": [],
  "sync_session_id": null,
  "idempotency_key": "..."
}
```

Before creating anything the server runs duplicate detection. If probable duplicates exist and none of them are in `acknowledged_duplicate_ids`, the call fails with:

```json
{
  "code": "DUPLICATE_SUSPECTED",
  "retryable": false,
  "possible_duplicates": [
    { "item_id": "kn_...", "title": "...", "revision_id": "rev_...", "content_hash": "sha256:...", "reason": "content_hash" }
  ]
}
```

Output:

```json
{
  "result": "proposal_created | committed",
  "policy_decision": "require_review | allow_direct",
  "proposal_id": "prop_...",
  "item_id": "kn_...",
  "revision_id": "rev_...",
  "content_hash": "sha256:..."
}
```

`item_id`, `revision_id` and `content_hash` are present only when `result = committed`.

#### `knowledge_propose_update`

Requires optimistic concurrency.

Input:

```json
{
  "item_id": "kn_01J...",
  "base_revision_id": "rev_...",
  "base_content_hash": "sha256:...",
  "title": "Authentication strategy",
  "markdown": "...",
  "category_paths": ["projects/pixel-brisbane/architecture"],
  "tags": ["auth"],
  "relations": [ { "type": "implements", "target": "kn_..." } ],
  "language": "en",
  "reason": "OAuth was implemented; previous text said planned.",
  "source_refs": [],
  "confidence": 0.98,
  "idempotency_key": "..."
}
```

Omitted fields keep their current values. `tags` and `relations`, when present, replace the full list. Relations of type `supersedes` cannot be set here; use `knowledge_propose_supersede`.

If canonical state changed, return `REVISION_CONFLICT` with the current revision id and content hash.

#### `knowledge_propose_supersede`

Atomic supersession: one operation, one commit, two revisions.

Input:

```json
{
  "old_item_id": "kn_01J...",
  "old_base_revision_id": "rev_...",
  "old_base_content_hash": "sha256:...",
  "valid_until": "2026-09-18T00:00:00Z",
  "new_item": {
    "title": "Backend database",
    "type": "fact",
    "language": "en",
    "category_paths": ["projects/pixel-brisbane/architecture"],
    "tags": [],
    "markdown": "The backend uses PostgreSQL.",
    "source_refs": [],
    "valid_from": "2026-09-18T00:00:00Z"
  },
  "existing_new_item_id": null,
  "reason": "Migration from MySQL completed.",
  "confidence": 0.99,
  "idempotency_key": "..."
}
```

Exactly one of `new_item` or `existing_new_item_id` is provided. On commit the server:

1. creates (or uses) the new item;
2. sets the old item `status = superseded` and `valid_until`;
3. records `new supersedes old` as a relation and in both frontmatters;
4. emits `knowledge.superseded` and `knowledge.created`/`knowledge.updated` events.

Output is the same shape as `knowledge_propose_create`, with `old_revision_id` added when committed.

#### `knowledge_propose_delete`

Deletion is reviewable and logical.

Input:

```json
{ "item_id": "kn_01J...", "base_revision_id": "rev_...", "base_content_hash": "sha256:...", "reason": "...", "idempotency_key": "..." }
```

### Proposals

#### `proposal_list`

Input:

```json
{ "status": ["pending", "conflict"], "mine": true, "target_item_id": null, "sync_session_id": null, "cursor": null, "limit": 50 }
```

`mine: false` requires `proposal.read_all`.

#### `proposal_get`

Input:

```json
{ "proposal_id": "prop_01J..." }
```

Returns the proposal, its policy decision, review status, resolution note, and resulting revisions when approved.

#### `proposal_withdraw`

Input:

```json
{ "proposal_id": "prop_01J...", "reason": "..." }
```

Only the proposer or a reviewer may withdraw. Resolved proposals return `PROPOSAL_ALREADY_RESOLVED`.

#### `proposal_approve`

Requires `knowledge.approve`. Intended for trusted curator agents and for human clients using the HTTP mapping.

Input:

```json
{
  "proposal_id": "prop_01J...",
  "edits": null,
  "note": "...",
  "idempotency_key": "..."
}
```

`edits` may carry a modified payload, producing `approved_with_edits`. An actor cannot approve its own proposal (`FORBIDDEN`).

#### `proposal_reject`

Input:

```json
{ "proposal_id": "prop_01J...", "reason": "...", "idempotency_key": "..." }
```

### Activity

#### `events_list`

The audit feed. Returns ledger events after a cursor.

Input:

```json
{ "after_sequence": 22010, "event_types": [], "category_paths": [], "limit": 200 }
```

`events.read_own` restricts the result to the caller's own events; `events.read_all` returns everything in scope. For synchronisation use `knowledge_changes` instead.

#### `activity_digest`

Returns an activity summary for a period.

Milestone 4: grouped counts by event type and a plain list of changed items and resolved proposals.

Milestone 8: optional generated narrative on top of the same data.

Input:

```json
{ "since": "2026-09-18T00:00:00Z", "until": "2026-09-19T00:00:00Z", "category_paths": [] }
```

### Reconciliation

#### `sync_begin`

Input:

```json
{ "source_system": "claude-code", "source_namespace": "project-x", "previous_sync_id": null }
```

Returns:

```text
sync_session_id
taxonomy_version
change_sequence
previous_checkpoint
recommended_index_queries
workspace stats
expires_at
```

#### `sync_submit_inventory`

Submits lightweight local candidate metadata without full content.

Input:

```json
{
  "sync_session_id": "sync_01J...",
  "candidates": [
    {
      "client_candidate_id": "c-000123",
      "external_key": "decision/auth",
      "source_content_hash": "sha256:...",
      "candidate_content_hash": "sha256:...",
      "source_modified_at": "...",
      "title": "Authentication strategy",
      "type": "decision",
      "language": "en",
      "proposed_category_paths": ["projects/pixel-brisbane/architecture"],
      "abstract": "Passwordless login and Google OAuth are implemented."
    }
  ]
}
```

`client_candidate_id` is required and unique within the session; resubmitting it is idempotent. `external_key`, `source_content_hash` and `candidate_content_hash` are optional but strongly improve matching.

Returns per candidate a classification, `match_reason` and `classification_state`:

- deterministic matches (external key, content hash with compatible type and category) are returned `final` immediately;
- others are returned `provisional` and refined by a background job.

#### `sync_get_matches`

Returns current classifications and candidate matches for a session.

Input:

```json
{ "sync_session_id": "sync_01J...", "only_final": false, "cursor": null, "limit": 200 }
```

Agents poll until every candidate is `final`; the response includes `pending_count`.

#### `sync_status`

Input:

```json
{ "sync_session_id": "sync_01J..." }
```

Returns session state, counts by classification, `pending_count`, expiry.

#### `sync_complete`

Marks an import/reconciliation pass complete and persists the checkpoint (`change_sequence`, taxonomy version, counts).

## 8. Direct-write behaviour

No separate write tools are exposed.

The same propose operations commit immediately when policy returns `allow_direct`, and create a pending proposal when it returns `require_review`. `result` is therefore always one of:

```text
proposal_created
committed
```

When policy returns `deny`, the call fails with `FORBIDDEN`, no proposal is created, and a `command.denied` event is recorded.

## 9. Errors

Every error is returned as an MCP tool error with a JSON payload:

```json
{
  "code": "REVISION_CONFLICT",
  "message": "Item kn_... changed since revision rev_...",
  "retryable": false,
  "object_ids": { "item_id": "kn_...", "proposal_id": null },
  "current": { "revision_id": "rev_...", "content_hash": "sha256:..." }
}
```

Codes are listed in `CLAUDE.md`. Messages are English and intended for the agent, not for end users.

## 10. Resources

MCP resources may expose:

```text
knoverge://workspace/manifest
knoverge://taxonomy
knoverge://item/{id}
knoverge://item/{id}/history
knoverge://briefing/{category-path}
knoverge://activity/recent
```

Tools remain the authoritative mutation interface.

## 11. Prompts

Optional MCP prompts can teach agents the expected workflow:

### `knowledge_onboarding`

Explains how to connect to a populated workspace.

### `knowledge_write_policy`

Explains when information is durable enough to propose, and the one-assertion-per-item rule.

### `knowledge_reconcile`

Guides a new agent through inventory comparison.

### `knowledge_session_start`

Explains the briefing-first pattern for a working session and the use of `knowledge_changes`.

These prompts are convenience only. Business rules remain server-side. Prompt text is English and reminds agents that item content is untrusted data.

## 12. Contract versioning

`workspace_manifest.server.contract_version` increments only on breaking changes. Additive changes (new optional fields, new tools) do not increment it. Breaking changes require an ADR and a compatibility note in the release.
