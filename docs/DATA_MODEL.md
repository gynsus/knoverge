# Data Model

This document defines domain entities, not exact SQL syntax.

Database migrations may refine indexes and constraints, but must preserve these concepts.

## 0. Identifiers

All primary keys are ULIDs with a type prefix, rendered as strings:

```text
ws_    workspace
usr_   user
mem_   workspace membership
act_   actor
ag_    agent
cred_  agent credential
sess_  human session
cat_   category
alias_ category alias
kn_    knowledge item
rev_   knowledge revision
src_   source reference
rel_   relation
prop_  proposal
evt_   event
op_    operation
sync_  sync session
cand_  sync candidate
att_   attachment
hook_  webhook
rule_  policy rule
grant_ permission grant
chunk_ search chunk
```

ULIDs are identifiers only. Ordering and cursors use explicit per-workspace `sequence` columns, never ULID order (ULIDs generated in the same millisecond are not ordered by commit time).

## 0a. What the schema enforces

The invariants below are constraints in PostgreSQL, not only rules in code:

- a category's parent is a real category, and its path ends in its own slug, so a lost path rewrite cannot leave the two disagreeing;
- every actor reference points at an actor;
- every enum-shaped column holds one of its values, because the repositories cast them straight into union types and anything else becomes a lie the domain believes;
- the event ledger rejects `UPDATE`, `DELETE` and `TRUNCATE`.

## 1. Workspace

```text
Workspace
- id
- slug
- name
- description
- default_language
- created_at
- updated_at
- archived_at nullable
- settings_json
```

`archived_at` is set while the workspace is kept and no longer written to. Reading, search and history are untouched; every action that would change the knowledge is refused for everyone, by the authorisation service rather than by a cascade over the rows. It is reversible, and both states are ledger events (`workspace.archived`, `workspace.restored`). See ADR 0018.

## 2. User

Instance-level human account.

```text
User
- id
- email (unique, case-insensitive)
- password_hash (argon2id)
- display_name
- locale (ui language, e.g. en, ru)
- status: active | disabled
- failed_login_count
- locked_until nullable
- password_changed_at
- created_at
- last_login_at
- mfa_json nullable (reserved for TOTP)
```

## 3. Workspace membership

```text
WorkspaceMembership
- id
- workspace_id
- user_id
- role: owner | admin | reviewer | viewer
- actor_id (the human Actor created for this membership)
- created_at
```

Roles:

- `owner`: everything, including deleting the workspace;
- `admin`: manage agents, policy, taxonomy, review;
- `reviewer`: review proposals, edit knowledge;
- `viewer`: read-only.

## 4. Human session

```text
HumanSession
- id
- user_id
- token_hash
- created_at
- expires_at
- revoked_at nullable
- user_agent, ip (for the session list)
```

## 5. Actor

Represents any entity capable of causing an auditable action inside a workspace.

```text
Actor
- id
- workspace_id
- type: human | agent | system
- display_name
- user_id nullable
- agent_id nullable
- created_at
- disabled_at
```

## 6. Agent

```text
Agent
- id
- workspace_id
- actor_id
- name
- description
- client_type
- trust_tier: read_only | propose | trusted
- status: active | disabled
- created_by_actor_id
- created_at
- last_seen_at
- metadata_json
```

Do not bind an agent identity permanently to one model.

`trust_tier` is a baseline set of permissions, evaluated rather than stored as grants (see SECURITY.md section 7) and policy defaults. Explicit grants and rules override it.

## 7. Agent credential

```text
AgentCredential
- id
- agent_id
- token_hash
- token_prefix
- label nullable
- created_by_actor_id
- created_at
- expires_at
- revoked_at
- last_used_at
```

Store only hashed tokens. Successful authentications update `last_used_at` and are logged; they are not ledger events.

## 8. Scope selector

Used by permission grants and policy rules. Stored by stable ids, never by mutable paths.

```json
{
  "categories": [
    { "category_id": "cat_01J...", "include_descendants": true }
  ],
  "types": ["observation", "episode"],
  "languages": []
}
```

Public APIs and the UI accept category paths for convenience and resolve them to ids at write time. An empty selector means the whole workspace. Renaming, moving or merging a category never changes who can access its items; merging re-points selectors to the surviving category.

## 9. Permission grant

```text
PermissionGrant
- id
- workspace_id
- actor_id
- action
- scope_json (Scope selector)
- effect: allow | deny
- created_by_actor_id
- created_at
```

Initial actions:

```text
knowledge.read
knowledge.read_history
knowledge.search
knowledge.propose_create
knowledge.propose_update
knowledge.propose_delete
knowledge.propose_supersede
knowledge.write
knowledge.approve
taxonomy.read
taxonomy.propose
taxonomy.manage
proposal.read_own
proposal.read_all
events.read_own
events.read_all
agent.manage
policy.manage
workspace.admin
```

`knowledge.read` scope also bounds `knowledge_changes`, search, index, briefing and the taxonomy view.

## 10. Policy rule

Decides `deny | allow_direct | require_review` for an action that the actor is permitted to attempt.

```text
PolicyRule
- id
- workspace_id
- priority (lower first)
- subject_json    { actor_id } | { trust_tier } | { actor_type }
- action          knowledge.create | knowledge.update | knowledge.delete | knowledge.supersede | taxonomy.create
- scope_json      Scope selector, optionally with review/evidence/dispute filters and source_types
- effect          deny | allow_direct | require_review
- enabled
- created_by_actor_id
- created_at
- updated_at
```

Evaluation: first enabled rule matching subject, action and scope wins. If no rule matches:

```text
agent read_only     deny
agent propose       require_review
agent trusted       require_review   (allow_direct only through an explicit rule)
human viewer        deny
human reviewer+     allow_direct
```

`deny` creates no proposal; it is recorded as a `command.denied` event.

## 11. Category

```text
Category
- id
- workspace_id
- parent_id
- slug
- path (materialised, unique per workspace)
- name
- description
- inclusion_guidance_json
- exclusion_guidance_json
- status: proposed | active | merged | archived | rejected
- merged_into_category_id nullable
- created_by_actor_id
- approved_by_actor_id
- created_at
- updated_at
```

## 12. Category alias

```text
CategoryAlias
- id
- category_id
- workspace_id
- alias
- normalised_alias
- created_at
```

An alias is unique per workspace after case folding and space collapsing, not merely per category.

```text
```

## 13. Taxonomy version

```text
TaxonomyVersion
- workspace_id
- version (monotonic; unique with workspace_id)
- git_commit_hash (commit that wrote taxonomy.yaml)
- created_at
```

## 14. Knowledge item

```text
KnowledgeItem
- id
- workspace_id
- slug
- markdown_path (derived: knowledge/<primary path>/<slug>.md)
- type
- status
- language
- current_revision_id
- review_state: unreviewed | agent_reviewed | human_reviewed
- evidence_state: none | source_backed | corroborated
- disputed: boolean           (derived from contradiction relations; ADR 0022)
- valid_from nullable
- valid_until nullable
- observed_at nullable
- source_system nullable
- external_key nullable      (unique with workspace_id + source_system)
- created_by_actor_id
- created_at
- updated_at
- deleted_at nullable
```

`trust_score` is computed from review, evidence, dispute and freshness for ranking. It is never stored as canonical data.

## 15. Knowledge item category

```text
KnowledgeItemCategory
- knowledge_item_id
- category_id
- is_primary
- position
```

Exactly one row per item has `is_primary = true` unless the item is uncategorised.

## 16. Tag and item tag

```text
Tag
- id
- workspace_id
- name              (as written, any script)
- normalised_name (unique per workspace)

`name` is the spelling to show; `normalised_name` is what decides sameness —
NFC, whitespace collapsed, trimmed, case folded. The rule lives in
`packages/contracts` so the API, the domain, the repository and the interface
agree on when two tags are one. See ADR 0019.

KnowledgeItemTag
- knowledge_item_id
- tag_id
```

## 17. Knowledge revision

```text
KnowledgeRevision
- id
- knowledge_item_id
- revision_number
- content_hash
- frontmatter_hash
- git_commit_hash
- title
- markdown_path
- frontmatter_json
- change_kind: create | update | move | metadata | delete | restore | supersede | superseded_by | import
- created_by_actor_id
- created_at
- operation_id
- proposal_id nullable
- reason nullable      (why, in whoever's own words)
```

Revisions are immutable. One operation (one commit) may produce several revisions, for example a supersession or a category merge.

`reason` is what the history could not say. It is written into the commit body
as well, above the trailers, where Git has always kept the reason for a change
— so `git log` answers without the application, which is the whole point of the
repository being canonical.

It is deliberately not in the frontmatter. The frontmatter describes the item;
a reason folded into it would enter the content hash, make every revision
differ from itself, and leave a reader of the file meeting last week's argument
at the top of this week's knowledge. It is also not in the ledger: events carry
ids, hashes and actor context, never text somebody wrote.

A revision rebuilt by recovery has none. Recovery reads trailers, and a reason
is free text in the body; the change survives and the sentence about it does
not, which is the honest trade rather than a parser that guesses.

## 18. Source reference

```text
SourceReference
- id
- workspace_id
- source_type
- uri nullable
- external_system nullable
- external_key nullable
- attachment_id nullable
- source_modified_at nullable
- source_content_hash nullable   (fingerprint of the raw source: file bytes, message, record)
- confidence nullable
- metadata_json
- created_at
```

`source_content_hash` is not the knowledge `content_hash`. It identifies the source material; `content_hash` identifies normalised Knoverge content.

## 19. Revision source

```text
RevisionSource
- revision_id
- source_reference_id
- evidence_role: primary | supporting | derived | contradicting
```

## 20. Relation

```text
KnowledgeRelation
- id
- workspace_id
- from_item_id
- relation_type
- to_item_id
- valid_from nullable
- valid_until nullable
- created_by_actor_id
- created_at
- removed_at nullable
```

Relations are mirrored into the frontmatter of `from_item`. They are changed through the `relations` list of `knowledge_propose_create` / `knowledge_propose_update` (full replacement, like tags) and through `knowledge_propose_supersede`.

## 21. Proposal

```text
Proposal
- id
- workspace_id
- proposal_type
- target_item_id nullable
- target_category_id nullable
- status
- proposed_by_actor_id
- base_revision_id nullable
- base_content_hash nullable
- proposed_payload_json
- reason
- confidence nullable
- acknowledged_duplicate_ids_json
- sync_session_id nullable
- policy_decision: allow_direct | require_review
- created_at
- resolved_at nullable
- resolved_by_actor_id nullable
- resolution_note nullable
- result_revision_ids_json
```

Proposal types:

```text
knowledge_create
knowledge_update
knowledge_delete
knowledge_supersede
category_create
category_update
```

Proposal status:

```text
pending
approved
approved_with_edits
rejected
superseded
withdrawn
conflict
```

Proposals that policy allowed directly are still recorded, with `status = approved` and `resolved_by_actor_id = system`, so the audit trail is uniform. Denied commands never become proposals.

`proposed_payload_json` is the only place outside Git where proposed knowledge text lives. Maintenance empties it 90 days after the proposal was resolved and keeps the row, so the workspace remembers who proposed what kind of change, when, how policy decided and what came of it, without holding the text — including text a reviewer rejected — indefinitely.

## 22. Event ledger

```text
Event
- id
- workspace_id
- sequence (per workspace, monotonic, gapless)
- hash_version (which field set event_hash covers)
- event_type
- actor_id
- agent_id nullable
- request_id
- session_id nullable
- client nullable
- provider nullable
- model nullable
- object_type
- object_id
- before_revision_id nullable
- before_content_hash nullable
- after_revision_id nullable
- after_content_hash nullable
- proposal_id nullable
- source_reference_id nullable
- category_ids_json          (the categories the event touched, before and after, for scoped feeds)
- metadata_json
- prev_event_hash
- event_hash
- created_at
```

Events are append-only. A database trigger rejects `UPDATE` and `DELETE` on the table; corrections are new events.

Content rule: an event never contains knowledge text, proposal payloads, credentials or secrets. It contains ids, hashes, actor context and safe metadata (counts, decision codes, category ids, change kinds). This keeps purge compatible with the immutable chain.

Chain: `event_hash = HMAC-SHA256(KNOVERGE_LEDGER_KEY, prev_event_hash || canonical_json(fields))`, where `fields` is an explicit, versioned list rather than whatever columns the table happens to have — so a migration that adds one cannot silently rehash history. The first event of a workspace uses `prev_event_hash` equal to the HMAC of the empty string. ADR 0007 gives the field list and the reasoning.

Two feeds are derived from the ledger:

- **audit feed** (`events_list`): all events, gated by `events.read_own` / `events.read_all`;
- **knowledge change feed** (`knowledge_changes`): only `knowledge.*`, `relation.*` and `category.*` events, filtered by the caller's `knowledge.read` scope using `category_ids_json`.

`category_ids_json` holds the union of where the item was and where it ended
up, not only the latter. ADR 0010 says an item that leaves the caller's scope
must appear to them as `deleted`; with only the new categories, an item moved
out of a branch somebody follows would simply stop appearing, and they would
keep a copy of something they may no longer read. The two sides separately are
in the event's metadata as `categories_before` and `categories_after`, which is
what the feed reports.

Event types recorded in the ledger:

```text
workspace.created
workspace.updated
user.created
user.password_reset
membership.created
membership.updated
agent.created
agent.updated
agent.credential_issued
agent.credential_revoked
permission.granted
permission.revoked
policy.rule_changed
command.denied
category.proposed
category.created
category.updated
category.moved
category.merged
category.archived
category.restored
knowledge.proposed_create
knowledge.proposed_update
knowledge.proposed_delete
knowledge.proposed_supersede
knowledge.created
knowledge.updated
knowledge.moved
knowledge.superseded
knowledge.deleted
knowledge.restored
knowledge.purged            (later milestone)
relation.created
relation.removed
proposal.approved
proposal.rejected
proposal.edited_and_approved
proposal.withdrawn
proposal.conflict
sync.started
sync.completed
sync.expired
summary.generated
attachment.uploaded
attachment.extracted
webhook.changed
integrity.check_completed
```

Not in the ledger (high volume or non-material): successful authentication, individual sync candidate classifications, search queries, job runs. These live in application logs, `AgentCredential.last_used_at` and `SyncCandidate`.

## 23. Operation

Used to coordinate PostgreSQL and Git.

```text
Operation
- id
- workspace_id
- operation_type
- state: pending | git_committed | db_committed | failed | recovered
- actor_id
- object_ids_json
- intended_payload_hash nullable
- git_commit_hash nullable
- taxonomy_version bigint nullable, so it can be compared with taxonomy_versions.version
- request_id
- session_id nullable
- agent_id nullable
- client nullable
- provider nullable
- model nullable
- error_json nullable
- created_at
- updated_at
```

The request context columns are not decoration. Recovery rebuilds a ledger event for an operation that reached Git but not PostgreSQL, and rule 3 requires an event to record the request, the session, the client and the model alongside the actor. The Git trailers carry the workspace, the actor, the agent, the proposal and the changes; they do not carry the rest, so a recovered event would otherwise record less than an ordinary one.

A commit hash and the state agree by constraint: `pending` and `failed` have none, and `git_committed`, `db_committed` and `recovered` have one.

A workspace holding a `pending` or `git_committed` operation refuses to be written to, and recovery runs at startup to resolve them. Decided rows — `db_committed`, `failed`, `recovered` — are history and are pruned by maintenance after thirty days; unfinished ones are never pruned at any age, because removing one would let the next write proceed over a repository the database does not agree with.

## 24. Agent sync state

```text
AgentSyncState
- id
- workspace_id
- agent_id
- source_system
- source_namespace nullable
- last_completed_sync_id nullable
- last_change_sequence nullable
- last_taxonomy_version nullable
- last_completed_at nullable
```

## 25. Sync session

```text
SyncSession
- id
- workspace_id
- agent_id
- source_system
- source_namespace nullable
- state
- taxonomy_version
- change_sequence_at_start
- created_at
- expires_at
- completed_at nullable
- stats_json
```

States:

```text
open
processing
waiting_for_agent
completed
failed
expired
```

Retention: the candidates of a pass finished more than ninety days ago are
removed, and the session row stays. Its `stats_json` was written when it
completed, so the run is still readable as a run; what goes is the
per-candidate detail, which is where an agent's own description of its own
material lives and which nothing reads once the pass is over. The same ninety
days a resolved proposal's text gets, because it is the same kind of content.

## 26. Sync candidate

```text
SyncCandidate
- id
- sync_session_id
- client_candidate_id            (required, unique within the session)
- external_key nullable
- source_content_hash nullable   (fingerprint of the agent's raw source)
- candidate_content_hash nullable (Knoverge-normalised title + body hash, if the client can compute it)
- source_modified_at nullable
- title
- knowledge_type
- language nullable
- proposed_category_paths_json
- abstract nullable
- classification
- classification_state: provisional | final
- match_reason: external_key | content_hash | lexical | semantic | none
- matched_item_ids_json
- server_reason_json
- created_at
- updated_at
```

Idempotency inside a session is `sync_session_id + client_candidate_id`.

Classifications:

```text
exact_known
likely_match
new_candidate
conflict
agent_copy_stale
server_copy_stale
ambiguous
ignored
```

Deterministic steps produce `final` classifications immediately. Lexical/semantic steps run in a job and may upgrade a `provisional` classification until it is `final`.

## 27. Summary dependency

```text
SummaryDependency
- summary_item_id
- source_item_id             (one row per source: primary key with the summary)
- source_revision_id
- position                   (the order the summary named them in)
```

Nothing marks a summary stale. It is stale when any `source_revision_id` here is
no longer the `current_revision_id` of the item beside it, computed where it is
asked rather than stored (ADR 0024). A new canonical revision of a source
therefore makes every summary that named the old one stale the instant it lands,
with no job in between and no flag to be wrong in the meantime.

The rows are replaced whole when a summary is written, the way relations and tags
are. What an older revision named is kept by that revision's own frontmatter.

`source_item_id` cascades nothing and restricts instead: a source disappearing
would leave a summary that silently forgets what it was made from, and rule 7
says the dependency is explicit. Deletion is logical, so this is only reachable by
a hard delete, which the product does not do.

## 28. Search document and search chunk

Rebuildable projections of canonical content.

```text
SearchChunk
- id
- knowledge_item_id
- workspace_id
- revision_id      (what it was built from, so a stale row is recognisable)
- language
- title            (repeated on every chunk, weighted above the text)
- ordinal          (zero-based, stable for the same text)
- text
- updated_at
- document_tsv     (generated: title weighted A, text weighted B, in `language`)
- simple_tsv       (generated: the same text unstemmed)
```

One row per chunk and no row per item: two granularities over the same text
drift, and every query then has to decide which one it believes (ADR 0020).

Chunks are produced by a deterministic paragraph-based splitter with a size
limit: paragraphs merged to a target, an over-long paragraph split on sentence
ends, and a sentence with no end split on a character count. Short items have
exactly one chunk. Canonical Markdown is never split — this is the index, and
`knoverge db reindex` rebuilds it from the files.

The vectors are generated columns, so a chunk cannot be indexed under one text
and searched under another. An item is ranked by its best chunk, never by the
sum of them: summing hands every query to the longest document, which has more
chances to contain the words by having more words.

## 29. Embedding profile and embedding

```text
EmbeddingProfile
- id
- workspace_id
- provider
- model
- dimensions
- status: active | rebuilding | retired
- created_at

Embedding
- id
- workspace_id
- profile_id
- chunk_id
- vector            (pgvector, no fixed dimension)
- created_at
```

Embeddings attach to chunks and go with them: a chunk is rewritten whenever its
item changes, and a vector for text that no longer exists is worse than none.
Search aggregates chunk scores to items and returns the best chunk with each
item.

Exactly one profile is `active` per workspace, and at most one is
`rebuilding` — both enforced by partial unique indexes. Changing model does not
blank semantic search: the new profile fills as `rebuilding` while the old one
keeps answering, and they change places when the last chunk is embedded.

`dimensions` is read from the model's own first answer rather than configured.
A number an operator has to keep in step with their model is a number that will
eventually be wrong, and vectors compared against vectors of another shape fail
without a symptom.

The vector column has no fixed dimension. One fixed in the DDL is what an index
over vectors needs, and it would refuse every model that does not have it;
exact search needs no index and is right at the size one self-hosted workspace
reaches. When a workspace outgrows it, the index and its fixed dimension are a
migration — cheap, because the index is derived.

## 29a. AI provider and assignment

```text
AiProvider
- id
- kind: ollama | openai_compatible
- name
- base_url                 (unique)
- origin: environment | interface
- last_checked_at
- last_error               (one line, never a body)
- created_at
- updated_at

AiAssignment
- purpose: embedding | generation   (primary key)
- provider_id
- model
- updated_at
```

Instance-level, with no `workspace_id`: one Ollama server is not a property of a
workspace. Both tables are empty in an installation with no AI provider, which
is the ordinary case (rule 9).

Configuration lives here rather than in the environment (ADR 0021). An operator
points at a server, finds out whether it answers, sees which models it holds and
changes their mind, and every step of that used to need a container restart. The
variables still provision a first start — if no provider exists and
`KNOVERGE_EMBEDDING_*` is set, a row is created from them with
`origin = environment` — and after that they are not read again. `origin` is what
the settings page shows when the compose file and the interface disagree.

API keys are not stored. Ollama needs none; a key in a database needs encryption
at rest, a key to encrypt it with and a decision about what happens when that is
lost. Until that exists, a provider that needs a key is one whose address is
named in `KNOVERGE_EMBEDDING_BASE_URL`, and the key reaches it from the
environment without ever being written down.

`base_url` is unique because two rows for one server are two places to change a
setting and one of them will be forgotten. Removing a provider cascades to its
assignments: one pointing at nothing reads as configured and embeds nothing.

`purpose` is the primary key of the assignment, so there is one answer to "what
embeds" rather than a list to choose from. `generation` is allowed and nothing
reads it yet.

## 30. Idempotency record

```text
IdempotencyRecord
- workspace_id
- actor_id
- idempotency_key
- request_hash
- response_json
- created_at
- expires_at
```

A repeated key with a different request hash must fail. The key is scoped to the workspace and the actor, the stored response never contains a secret, and an expired record is replaced by the next call. Records are removed by maintenance, not on the request path: the worker prunes them hourly, and `knoverge db prune` runs the same work on demand.

## 31. Attachment

Later milestone. See ADR 0008.

```text
Attachment
- id
- workspace_id
- sha256
- media_type
- size_bytes
- original_filename
- original_uri nullable
- storage_path
- extraction_status: none | pending | done | failed | unsupported
- extracted_item_id nullable
- uploaded_by_actor_id
- created_at
```

## 32. Webhook

Milestone 9.

```text
Webhook
- id
- workspace_id
- url
- secret_ciphertext   (encrypted with KNOVERGE_ENCRYPTION_KEY; needed in clear to sign payloads)
- event_types_json
- status
- created_at
- last_delivery_at
- last_error nullable
```

Signing secrets are encrypted, not hashed, because the server must recover them. Passwords and bearer tokens remain one-way hashes.

## 33. Jobs

pg-boss manages its own tables in the `pgboss` schema. Drizzle keeps its migration log in `drizzle.__drizzle_migrations`. Domain tables never reference job ids.
