# CLAUDE.md

This file is the primary implementation instruction for Claude Code.

Read this file first. Then read the linked specifications before writing application code.

## Project

Name: **Knoverge**

Short description: a knowledge ledger for humans and AI agents.

Knoverge is an open-source, self-hosted shared knowledge control plane for humans and AI agents.

The system exposes a persistent knowledge base through MCP and HTTP APIs. It records provenance, maintains version history, supports agent-specific permissions, allows human review, and prevents newly connected agents from blindly duplicating existing knowledge.

## Language rules

- All code, identifiers, comments, commit messages, documentation, ADRs, MCP tool descriptions, MCP prompts, error codes, and log messages are written in English.
- Text shown to humans in the web UI and in human-facing messages (digests, notifications, UI error messages) goes through message catalogues and is translatable. English is the source language. Russian is the first translation.
- Never hard-code user-facing UI strings. See `docs/I18N.md`.
- Knowledge content itself may be in any language and carries a `language` field.

## Required reading order

Before implementing features, read:

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/KNOWLEDGE_MODEL.md`
4. `docs/GIT_REPOSITORY.md`
5. `docs/DATA_MODEL.md`
6. `docs/KNOWLEDGE_LIFECYCLE.md`
7. `docs/AGENT_ONBOARDING_AND_RECONCILIATION.md`
8. `docs/MCP_API.md`
9. `docs/HTTP_API.md`
10. `docs/SECURITY.md`
11. `docs/I18N.md`
12. `docs/IMPLEMENTATION_PLAN.md`
13. `docs/TESTING.md`
14. `docs/CODEBASE.md`
15. `docs/adr/`

Architecture changes require an ADR under `docs/adr/`.

## Non-negotiable architectural rules

### 1. Canonical content is portable and self-describing

Knowledge content must remain readable and navigable without the application.

Canonical knowledge items are Markdown files with YAML frontmatter stored in a Git repository, one repository per workspace.

The repository must be self-describing:

- files live under the category path: `knowledge/<category-slug-path>/<item-slug>.md`;
- frontmatter references categories by slug path, never by database id;
- the taxonomy is stored in the repository as `taxonomy.yaml`;
- sources and relations are recorded in frontmatter as a portable projection.

Do not make vector embeddings, search indexes, or opaque binary records the canonical knowledge representation.

Every change to an item, including metadata-only changes, is a new revision and a Git commit. There are no revisions that bypass Git.

### 2. PostgreSQL stores operational state

PostgreSQL is authoritative for:

- workspaces;
- users and memberships;
- actors;
- agents and credentials;
- permissions and policy rules;
- categories;
- item metadata;
- revision metadata;
- proposals;
- events;
- source references;
- relations (queryable index; frontmatter carries the portable copy);
- sync sessions;
- review state;
- summary dependency state;
- attachments metadata;
- jobs.

### 3. Every material write is attributable

Every create/update/delete/supersede/approve/reject action must record:

- actor type;
- actor id;
- agent identity if applicable;
- client;
- model when known;
- session id when known;
- request id;
- source references;
- timestamp;
- affected object;
- before revision/hash;
- after revision/hash.

### 4. Event ledger is append-only and keyed hash-chained

Application code must never update or delete an existing audit event through normal domain operations.

Corrections are represented by new events.

Each event stores the HMAC-SHA256 (key `KNOVERGE_LEDGER_KEY`, never stored in the database) of the previous event hash and its own canonical content. Events contain ids, hashes, actor context and safe metadata only, never knowledge text, proposal payloads or secrets.

Only material changes are ledger events. Successful authentications, per-candidate sync classifications and job runs are not.

Cursors are the per-workspace `sequence`, never object ids. Agents synchronise through `knowledge_changes` (scoped by `knowledge.read`), not through the audit feed.

### 5. Agents do not silently overwrite canonical knowledge

By default, agents receive:

- read;
- search;
- propose.

Direct write requires an explicit permission and a policy rule that allows it.

### 6. Optimistic concurrency is mandatory

Updates to existing knowledge must include the revision id and content hash the agent read.

If current canonical state has changed, return a conflict instead of overwriting.

### 7. Summaries are derived

A summary must keep explicit dependencies on source revisions.

If any dependency changes, the summary becomes stale.

### 8. Search is not authority

Search returns candidates.

The caller must be able to retrieve the canonical item, revision, provenance, review/evidence/dispute state, status, and source information.

### 9. Core must run without an LLM

LLM features are optional.

The following must work without any AI provider:

- CRUD/proposals;
- Git history;
- categories;
- audit;
- review;
- exact and full-text search;
- MCP and HTTP access;
- sync sessions;
- reconciliation by hashes/external IDs;
- briefing;
- basic activity digest.

### 10. Do not introduce infrastructure without demonstrated need

MVP must not require:

- Redis;
- Kafka;
- Elasticsearch;
- Neo4j;
- Kubernetes;
- object storage.

A complete installation is one application container plus PostgreSQL.

Add a dependency only through an ADR explaining why PostgreSQL/Git/filesystem cannot meet the requirement.

### 11. One contract for MCP and HTTP

Tool names, input schemas, output schemas, and error codes are defined once in `packages/contracts`.

MCP exposes them as tools. HTTP exposes them as `POST /v1/<tool_name>`.

Tool names use lowercase letters, digits, and underscores only (`knowledge_search`, not `knowledge.search`).

### 12. No telemetry

The server must not contact any external service unless the operator has explicitly configured it.

### 13. Authorisation scopes use stable ids

Permission grants and policy rules store category scopes as `category_id` plus `include_descendants`. Category paths are accepted at the API and UI boundary and resolved to ids at write time. A path is a portable identifier, never a security identifier.

### 14. Policy fails safe

Without an explicit `allow_direct` rule, every agent write requires review, including agents in the `trusted` tier. A `deny` creates no proposal and is recorded as a `command.denied` event.

### 15. One item, one assertion

`fact`, `decision`, `instruction` and `preference` items hold one independently updateable assertion each. Large source material is a `document`.

## Technical baseline

Use:

- Node.js, current Active LTS line (pin in `.nvmrc` and `engines`)
- TypeScript strict mode
- pnpm workspaces
- Turborepo
- Fastify
- Zod
- Drizzle ORM with SQL migrations
- PostgreSQL 16+ with `pgvector`, `pg_trgm`, `unaccent`
- pg-boss
- Git CLI through `packages/git-store`
- React with Vite (SPA), i18next
- official MCP TypeScript SDK, Streamable HTTP transport
- Vitest, Testcontainers
- Docker Compose

Prefer native `fetch` and standard platform APIs when practical.

Exact versions are chosen and pinned in Milestone 0 and kept current through automated dependency updates. See `docs/adr/0006-implementation-stack.md`.

## Target workspace structure

```text
apps/
  server/
  web/
  cli/

packages/
  auth/
  contracts/
  core/
  db/
  git-store/
  intelligence/
  policy/
  search/

infra/
  docker/

docs/
  adr/
  i18n/
```

## Package responsibilities

### `apps/server`

One Node.js process that hosts:

- HTTP API (`/v1`);
- MCP endpoint (`/mcp`);
- static web bundle (`/`);
- background worker (pg-boss), separable through `KNOVERGE_ROLE`.

Adapters only. No business rules.

### `apps/web`

React SPA. Talks to `/v1`. All strings through i18next.

### `apps/cli`

`knoverge` command: bootstrap, integrity check, backup/restore helpers, MCP stdio bridge to a remote server.

### `packages/contracts`

Contains shared schemas and public contract types.

Use Zod as the runtime schema source.

Expose inferred TypeScript types.

Do not import database implementation here.

### `packages/core`

Domain services and domain errors.

Must depend on interfaces, not concrete storage implementations.

### `packages/db`

PostgreSQL schema, migrations, repositories, transactions.

### `packages/git-store`

Markdown serialisation, frontmatter parsing, content hashing, file layout, Git revision operations, diff, restore, repository locking.

### `packages/search`

FTS, vector retrieval, hybrid ranking.

Search indexing must be rebuildable from canonical data.

### `packages/auth`

Token parsing, identity resolution, token hashing, password hashing, session context.

### `packages/policy`

Permission and approval policy evaluation.

### `packages/intelligence`

Optional provider abstraction for:

- embeddings;
- categorisation assistance;
- duplicate detection assistance;
- summaries;
- contradiction suggestions;
- text extraction, transcription and image description (later milestones).

No core domain module may require this package to function.

## API design rules

All mutating calls require:

- `request_id`
- `actor context`
- `idempotency_key` where retry is plausible

All item updates require:

- `base_revision_id`
- `base_content_hash`

All externally sourced records should support:

- `source_system`
- `external_key`
- `source_modified_at`
- `source_content_hash`

## Error model

Use stable machine-readable error codes.

Minimum set:

```text
UNAUTHENTICATED
FORBIDDEN
NOT_FOUND
VALIDATION_ERROR
REVISION_CONFLICT
DUPLICATE_EXTERNAL_KEY
DUPLICATE_SUSPECTED
CATEGORY_CONFLICT
PROPOSAL_ALREADY_RESOLVED
SYNC_SESSION_EXPIRED
POLICY_REQUIRES_REVIEW
RATE_LIMITED
INTERNAL_ERROR
```

Errors returned through MCP and HTTP must contain:

- code;
- human-readable message (English);
- retryable boolean;
- relevant object ids;
- current revision/hash for concurrency conflicts.

## Markdown representation

Example:

```markdown
---
id: kn_01J8Z3M4Q9V0X7K2B5N6P8R1T3
title: Authentication strategy
type: decision
status: active
language: en
categories:
  - projects/pixel-brisbane/architecture
tags:
  - auth
review: human_reviewed
evidence: source_backed
disputed: false
valid_from: 2026-09-19T09:20:00Z
valid_until: null
created_at: 2026-09-19T09:00:00Z
updated_at: 2026-09-19T09:20:00Z
sources:
  - type: agent_session
    client: claude-code
    role: primary
relations:
  - type: supersedes
    target: kn_01J8Z2A0C1D2E3F4G5H6J7K8L9
---

Passwordless login uses a six-digit email code.

Google OAuth is supported.
```

Do not place secrets, agent tokens, database-internal ids other than portable object ids, or embeddings into Markdown.

## Repository workflow

Full rules: `docs/WORKFLOW.md`. Summary:

- Run `nvm use` first. Never commit to `main`; it is protected. Work on `<type>/<short-description>` branches (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `security`) and open a pull request. Split large milestones into several PRs.
- Read this file and the relevant specs before coding. If code and spec disagree, stop, resolve the conflict in the spec (ADR if architectural), then continue.
- Implement only the requested task. No next-milestone work, speculative abstractions or unrequested dependencies.
- Contracts first: `packages/contracts`, then domain, then both MCP and HTTP adapters, then tests for both.
- Persistence change means Drizzle schema, migration, repository tests and `DATA_MODEL.md`. Before v0.1.0 migrations may be squashed into one baseline (say so in the PR); after v0.1.0 they are immutable.
- UI text only through `en` and `ru` catalogues.
- Before committing run `pnpm lint`, `pnpm typecheck`, `pnpm test` and review `git diff`. Report any check that could not run.
- Commits: Conventional Commits, `git commit -s` with the maintainer's identity, no other attribution trailers. PR descriptions carry no tool attribution lines.
- Rebase on `origin/main` before the PR; never merge `main` into the branch; `--force-with-lease` only.
- Never merge a PR unless the owner says so.
- Every PR is self-contained: green checks, no half-wired code, tests and docs included, even for a partial milestone.
- Never bypass hooks or checks (`--no-verify`, custom `core.hooksPath`).
- Finish every task with the end-of-task report from `docs/WORKFLOW.md` section 22.

## Implementation behaviour

When a requirement is unclear:

1. prefer the smallest implementation that preserves the architecture;
2. record the interpretation in the relevant doc;
3. create an ADR only for architectural decisions;
4. do not silently invent large subsystems.

## Completion definition

A feature is not complete unless it has:

- domain validation;
- persistence;
- event recording;
- permission checks;
- tests;
- public contract/schema;
- relevant documentation;
- migration if persistence changed;
- message catalogue entries (English and Russian) if it adds UI text.

For MCP-exposed features, add an integration test through the MCP adapter and through the HTTP RPC endpoint.

## Development order

Follow `docs/IMPLEMENTATION_PLAN.md`.

Do not begin advanced summarisation, graph features, media ingestion, or autonomous knowledge gardening before the reconciliation protocol and review workflow are complete.
