# Implementation Plan

Build vertically and keep every milestone runnable.

## Milestone 0 - repository scaffold

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
- pinned tool versions (`.nvmrc`, `engines`), automated dependency updates.

Acceptance:

```text
docker compose up
```

starts a working environment with a web page and `/health/ready` green.

## Milestone 1 - identity, workspace and taxonomy

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

Deliver:

- source references and revision-source links;
- relations with frontmatter mirroring;
- evidence state derivation (`source_backed`, `corroborated`);
- contradiction and the `disputed` flag;
- temporal validity;
- provenance UI.

## Milestone 8 - summaries and digests

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

Deliver:

- Knoverge as OAuth 2.1 authorization server with PKCE and dynamic client registration;
- consent screen binding an OAuth client to an agent identity;
- token introspection reusing the agent permission model;
- verified connection from ChatGPT and Claude.ai connectors.

ADR required before implementation.

## Milestone 11 - documents and attachments

Deliver:

- attachment upload (web UI, HTTP, MCP);
- content-addressed storage under the data directory;
- text extraction for plain text, Markdown, HTML, PDF, DOCX into `document` items linked to the attachment and to the original location;
- unsupported files stored by reference only;
- attachment references in provenance.

See ADR 0008.

## Milestone 12 - media understanding

Deliver through the intelligence provider abstraction:

- audio transcription;
- video transcription;
- image description and OCR;

each producing `document` items with provenance. Providers are optional; without them media attachments are stored by reference.

## Milestone 13 - export and import

Deliver:

- full workspace export (Git bundle plus metadata JSON) and import;
- importers producing reconciliation sessions rather than blind inserts: Markdown folder, Obsidian vault, ChatGPT export, generic JSON;
- importer for externally created Git commits.

## Milestone 14 - knowledge gardening

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
