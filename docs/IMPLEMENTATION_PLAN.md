# Implementation Plan

Build vertically and keep every milestone runnable.

## Where this is

Milestones 0 to 9 are delivered. **v0.1.0** was cut on 28 September 2026 and is the
first tagged release; **v0.2.0** added the webhooks screen. `CHANGELOG.md` says what
each one contains, and every milestone below carries the release it arrived in.

From v0.1.0 the migrations are immutable: a change to persistence is a new additive
migration with an upgrade test, never an edit to one that shipped.

Milestone 10 is next in this order and needs an ADR before any of it is written.
Which milestone is taken next is a decision about the product rather than about the
code — 10 is what a hosted connector needs, 11 is what somebody with a folder of
documents needs — and the order here is the default, not a promise.

## Milestone 0 - repository scaffold

_Delivered — v0.1.0._

Deliver:

- pnpm monorepo, Turborepo;
- TypeScript strict configuration;
- `apps/server` (Fastify) with health endpoints and static serving;
- `apps/web` (React + Vite) with i18next and `en`/`ru` catalogues;
- `apps/cli` skeleton;
- PostgreSQL Docker service with `vector`, `pg_trgm`, `unaccent`;
- Drizzle schema and migration workflow;
- pg-boss wiring;
- lint/format/test commands, Vitest, Testcontainers;
- CI (lint, typecheck, test, catalogue completeness);
- `.env.example`, single-container `docker-compose.yml`;
- pinned tool versions (`.nvmrc`, `engines`), automated dependency updates
  (`.github/dependabot.yml`: packages, actions and base images, weekly and grouped;
  a version that lives in the pnpm catalogue may still need a hand, and
  `pnpm outdated -r` is what says so).

Acceptance:

```text
docker compose up
```

starts a working environment with a web page and `/health/ready` green.

## Milestone 1 - identity, workspace and taxonomy

_Delivered — v0.1.0._

Deliver:

- users, sessions, login/logout, bootstrap;
- workspaces and memberships;
- actors;
- agents with trust tiers, credential issue/revoke/rotate;
- permission grants and policy rules with id-based scope selectors (storage and evaluation);
- category CRUD, aliases, slug paths, taxonomy version;
- keyed hash-chained event ledger with per-workspace sequence and category snapshots;
- idempotency records;
- web security baseline: login rate limiting and lockout, secure cookies, CSRF, body limits, security headers.

Web UI:

- login, workspace settings;
- members;
- agents and credentials;
- policy rules;
- taxonomy browser/editor.

## Milestone 2 - canonical knowledge + Git history

_Delivered — v0.1.0._

Deliver:

- knowledge items, tags, categories join, review/evidence/dispute state;
- revisions with content and frontmatter hashes, multi-revision commits with `Knoverge-Change` trailers;
- Markdown renderer/parser with the frontmatter contract;
- workspace Git repository with the defined layout, `taxonomy.yaml`, generated `README.md`;
- Git commit per canonical write, trailers;
- history, diff, logical delete, restore, move on recategorisation;
- operation table and PostgreSQL/Git recovery;
- human editing in the web UI.

Tests must simulate process failure between Git and database stages.

## Milestone 3 - proposals, policy and review

_Delivered — v0.1.0._

Deliver:

- create/update/delete/supersede proposals, relations through the `relations` list;
- optimistic concurrency;
- duplicate check on create (external key, content hash, lexical);
- policy result: deny (no proposal, `command.denied` event) / allow_direct / require_review, fail-safe defaults;
- review inbox;
- approve, edit-and-approve, reject, withdraw, conflict;
- proposal audit trail.

At this point agents can safely contribute information.

## Milestone 4 - MCP and HTTP surface

_Delivered — v0.1.0._

Deliver the shared contract and both adapters:

```text
workspace_manifest
taxonomy_list
taxonomy_propose
knowledge_search          (lexical only until Milestone 6)
knowledge_get             (bounded by max_chars/offset)
knowledge_index
knowledge_briefing
knowledge_changes
knowledge_propose_create
knowledge_propose_update
knowledge_propose_supersede
knowledge_propose_delete
knowledge_history
knowledge_diff
proposal_list
proposal_get
proposal_withdraw
proposal_approve
proposal_reject
events_list
activity_digest           (counts and plain lists, no LLM)
```

Add remote MCP over Streamable HTTP, `POST /v1/<tool_name>`, OpenAPI generation, and the CLI stdio bridge.

Agent security baseline: per-agent rate limits (read/search, proposals, sync), MCP request size and concurrency limits, connection limits per token.

Integration tests must call the MCP server and the HTTP endpoint rather than only domain services.

## Milestone 5 - reconciliation protocol

_Delivered — v0.1.0._

Deliver:

```text
sync_begin
sync_submit_inventory
sync_get_matches
sync_status
sync_complete
```

Matching order:

1. external key;
2. content hash;
3. deterministic metadata filters;
4. lexical similarity (job);
5. optional vector similarity (job).

Candidates carry `client_candidate_id` (idempotency), optional `external_key`, and both `source_content_hash` and `candidate_content_hash`. Freshness classifications require known lineage.

Deliver resumable sync sessions and checkpoints on `change_sequence`.

Web UI:

- onboarding/sync run;
- candidate classifications;
- proposal filtering by sync session.

This milestone is mandatory before calling the product a shared multi-agent knowledge system.

## Milestone 6 - hybrid search

_Delivered — v0.1.0._

Deliver:

- search chunks: deterministic paragraph splitter, per-chunk FTS;
- language-aware PostgreSQL FTS with `unaccent`;
- trigram matching;
- pgvector embeddings per chunk, embedding profiles and rebuild;
- embedding provider abstraction;
- hybrid score;
- filters and category subtree search;
- semantic step in duplicate check and reconciliation.

System still works if embeddings are disabled.

## Milestone 7 - provenance, relations and temporal knowledge

_Delivered — v0.1.0._

Deliver:

- source references and revision-source links;
- relations with frontmatter mirroring;
- evidence state derivation (`source_backed`, `corroborated`);
- contradiction and the `disputed` flag;
- temporal validity;
- provenance UI.

## Milestone 8 - summaries and digests

_Delivered — v0.1.0._

Deliver:

- optional LLM provider abstraction;
- derived summaries;
- summary dependencies;
- stale detection;
- regeneration;
- daily/weekly activity digest with optional generated narrative;
- digest links back to revisions/proposals.

No generated summary may replace canonical sources.

## Milestone 9 - hardening and operations

_Delivered — v0.1.0, and the webhooks screen in v0.2.0._

Deliver:

- advanced rate limiting and abuse controls;
- webhooks with encrypted signing secrets;
- ledger key rotation support;
- `knoverge backup` / `restore` helpers;
- integrity checker (operations, ledger hash chain, Git/PostgreSQL agreement, frontmatter/PostgreSQL agreement);
- token rotation UI;
- audit export;
- deployment guide with Caddy example;
- release images;
- migration upgrade tests;
- Russian translation complete for everything shipped so far.

## Milestone 10 - OAuth 2.1 for hosted MCP clients

_Not started. ADR required first._

Deliver:

- Knoverge as OAuth 2.1 authorization server with PKCE and dynamic client registration;
- consent screen binding an OAuth client to an agent identity;
- token introspection reusing the agent permission model;
- verified connection from ChatGPT and Claude.ai connectors.

ADR required before implementation.

## Milestone 11 - documents and attachments

_Delivered. Storage, the record, the HTTP surface, text extraction (text,
Markdown, HTML, PDF, DOCX), the Files screen and the three MCP tools._

Deliver:

- attachment upload (web UI, HTTP, MCP);
- content-addressed storage under the data directory;
- text extraction for plain text, Markdown, HTML, PDF, DOCX into `document` items linked to the attachment and to the original location;
- unsupported files stored by reference only;
- attachment references in provenance.

See ADR 0008. Files live at `KNOVERGE_DATA_DIR/attachments/<workspace_id>/<sha256>`,
beside `repositories/<workspace_id>` and the way `ARCHITECTURE.md` has always
described them.

Two things the first part left for the rest of the milestone, both deliberate:

- **The item made from a file meets the policy like any other write.** An agent
  holding `knowledge.write` may put a file here, because a file is not knowledge.
  What the file *says* becomes a `document` item, and that write goes through the
  policy — an agent's upload produces a proposal, not canonical knowledge (rule 5).
  Extraction is where that is decided, and it has to be decided there.
- **An upload is held in memory while it is hashed and written**, which is why
  `KNOVERGE_ATTACHMENT_MAX_MB` is capped at 128. Streaming it through the store
  would remove the ceiling; it is not built, and nothing needs it yet.

## Milestone 12 - media understanding

_Done, except one case. An image is described by an assigned vision model, which is
also how the text in a screenshot is read, and an audio or video file becomes what
was said in it when a transcription model is assigned — an OpenAI-compatible one,
since Ollama has no endpoint that listens. A scanned PDF is still `unsupported`: a
page inside one has to be rendered to an image first, and rendering needs a canvas
this product does not have._

Deliver through the intelligence provider abstraction:

- audio transcription;
- video transcription;
- image description and OCR;

each producing `document` items with provenance. Providers are optional; without them media attachments are stored by reference.

## Milestone 13 - export and import

_Not started._

Deliver:

- full workspace export (Git bundle plus metadata JSON) and import;
- importers producing reconciliation sessions rather than blind inserts: Markdown folder, Obsidian vault, ChatGPT export, generic JSON;
- importer for externally created Git commits.

## Milestone 14 - knowledge gardening

_Not started._

Only after previous milestones are stable.

Possible proposal-generating jobs:

- duplicate detection;
- merge suggestions;
- taxonomy cleanup;
- stale instruction detection;
- contradiction detection;
- orphan source detection;
- weak-provenance detection.

All automatic gardening creates proposals unless explicitly authorised.

## Later

- end-to-end browser tests for the review and knowledge flows (Playwright; no
  harness yet, and `docs/TESTING.md` says so where somebody writing a test will
  read it);
- physical purge of Git history for secrets and personal data;
- TOTP and OIDC sign-in;
- commit signing;
- optional object storage for attachments (ADR required).

## Out of MVP scope

Do not implement early:

- CRDT;
- distributed consensus;
- multi-region;
- graph database dependency;
- autonomous agents inside the server;
- chat UI intended to compete with ChatGPT/Claude;
- workflow automation platform;
- secret manager;
- file storage platform.
