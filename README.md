# Knoverge

> A knowledge ledger for humans and AI agents. Self-hosted, MCP-native, auditable.

Knoverge is an open-source, self-hosted knowledge base designed to be shared by multiple AI agents and humans through MCP and HTTP APIs.

Its purpose is not merely to provide "long-term memory". It is a **knowledge ledger**: the canonical, auditable source of durable knowledge for a person, team, project, or organisation.

Every important change is attributable to a specific actor, traceable to its source, versioned, reviewable, and reversible.

## Core idea

A user may work with many independent AI systems:

- ChatGPT
- Claude Code
- Codex
- OpenClaw
- local Ollama-based agents
- IDE agents
- custom automations
- future MCP-compatible systems

Each agent has its own context and memory. Knoverge gives them a shared external knowledge layer that is available 24/7.

Typical workflow:

```text
Agent discovers information
        ↓
Agent checks existing knowledge
        ↓
Agent proposes a new item or update
        ↓
Server detects duplicates/conflicts
        ↓
Policy decides whether review is required
        ↓
Human or trusted curator approves
        ↓
Canonical knowledge is updated
        ↓
All other agents can retrieve the new version
```

## Product principles

1. **Self-hosted first**
   - The default deployment is the user's own server or private cloud.
   - Local-only deployment must also be supported.
   - No mandatory SaaS dependency.
   - One application container plus PostgreSQL is a complete installation.

2. **MCP-native**
   - Any MCP-capable agent should be able to connect to the same instance.
   - MCP is the primary agent interface.
   - The HTTP API exposes the same domain operations with the same schemas.

3. **Human remains in control**
   - Agents can be restricted to read-only, propose-only, or trusted write access.
   - Sensitive areas can always require manual approval.
   - Every automated decision must be inspectable.

4. **Git-like knowledge history**
   - Canonical Markdown is versioned in a real Git repository.
   - Previous versions are retained.
   - Changes can be diffed and restored.
   - The repository is readable and navigable without Knoverge.

5. **Immutable provenance**
   - Every create/update/delete/proposal/approval is written to an append-only, keyed hash-chained event ledger.
   - Events identify the agent, model, client, session, source, and affected knowledge revision.

6. **Knowledge evolves instead of being silently overwritten**
   - Old facts may become superseded.
   - Historical validity can be retained.
   - Conflicting claims can coexist until resolved.

7. **Summaries are derived data**
   - A summary is never silently promoted to canonical fact.
   - It records the knowledge revisions from which it was generated.
   - It becomes stale when its inputs change.

8. **No vector database as source of truth**
   - Vector indexes are retrieval infrastructure only.
   - PostgreSQL metadata + canonical Markdown/Git remain authoritative.

9. **No telemetry**
   - Knoverge never contacts external services unless you configure an AI provider or a webhook yourself.
   - There is no usage tracking, no phone-home, no analytics.

10. **English-first, translatable**
   - Code, comments, documentation, agent-facing contracts, and machine-readable identifiers are English.
   - The user interface and messages addressed to humans are translatable. Russian is the first translation.

## Primary use cases

### Personal knowledge hub

One person connects multiple assistants to one persistent knowledge system.

Examples:

- project decisions;
- technical architecture;
- preferences and recurring instructions;
- job-search information;
- research;
- documents and summaries;
- business processes;
- personal notes intended for AI reuse.

### Software development

Claude Code writes implementation discoveries and architecture decisions into the shared knowledge base.

At the start of the next session, any agent can request a compact briefing for the project and retrieve:

- current architecture;
- why a decision was made;
- superseded approaches;
- unresolved issues;
- known constraints.

### Multi-agent operation

Different specialised agents can work on the same workspace without sharing one LLM context.

Examples:

- research agent;
- coding agent;
- content agent;
- job-search agent;
- monitoring agent;
- summarisation agent.

## Canonical storage model

Two histories are maintained deliberately.

### Git-backed canonical content

Answers:

> What did this knowledge item contain at revision N?

Used for:

- Markdown content and frontmatter;
- taxonomy snapshot;
- diff;
- rollback;
- human editing;
- backup and portability.

The repository is self-describing: categories are referenced by slug path, the taxonomy is stored as a file, and sources and relations are recorded in frontmatter. See [docs/GIT_REPOSITORY.md](docs/GIT_REPOSITORY.md).

### Append-only event ledger

Answers:

> Who caused this change, from which agent/session/source, and how was it approved?

Used for:

- provenance;
- audit;
- agent attribution;
- policy decisions;
- approvals;
- rejected proposals;
- synchronisation history.

Each event carries a keyed hash (HMAC) of the previous event and its own content, so tampering by anyone without the ledger key, including a database administrator or a leaked backup, is detectable. Events carry ids and hashes, never knowledge text.

Agents synchronise through a separate knowledge change feed derived from the same ledger, scoped to what they may read.

Git history and event history are related, but are not the same thing.

## Knowledge model

Knowledge is not stored as a flat bag of memories.

Initial knowledge types:

- `fact`
- `decision`
- `instruction`
- `preference`
- `procedure`
- `observation`
- `episode`
- `document`
- `insight`
- `summary`

Knowledge is organised using:

- stable hierarchical categories;
- lightweight tags;
- explicit relations;
- source references;
- temporal validity;
- lifecycle status;
- review, evidence and dispute state;
- content language.

One item holds one independently updateable assertion or decision; large source material lives in `document` items.

See [docs/KNOWLEDGE_MODEL.md](docs/KNOWLEDGE_MODEL.md).

## Client compatibility

| Client | MVP |
| --- | --- |
| Claude Code | Yes, bearer token over remote MCP or stdio bridge |
| Cursor and other IDE MCP clients | Yes |
| Custom MCP agents, scripts, automations | Yes (MCP or HTTP) |
| Local agents (Ollama-based, OpenClaw, and similar) | Yes |
| ChatGPT hosted connector | Later, requires the OAuth 2.1 milestone |
| Claude.ai hosted connector | Later, requires the OAuth 2.1 milestone |

Hosted connectors require OAuth 2.1; that is Milestone 10 in the roadmap. Until then, connect those assistants through a local MCP bridge where the platform allows it.

## Connecting a new agent to an existing workspace

A new agent must not immediately upload all of its memory.

The onboarding process is a reconciliation protocol:

```text
1. Authenticate
2. Request workspace manifest
3. Request taxonomy and policy
4. Request compact knowledge index
5. Build local inventory
6. Submit inventory metadata for matching
7. Server classifies candidates
8. Agent fetches only relevant full records
9. Agent compares its information with canonical knowledge
10. Agent proposes only new or changed information
11. Human/policy review
12. Save sync checkpoint
```

The server can classify each candidate as:

- `exact_known`
- `likely_match`
- `new_candidate`
- `conflict`
- `agent_copy_stale`
- `server_copy_stale`
- `ambiguous`
- `ignored`

This prevents the common failure mode where every new AI agent dumps a second copy of the same knowledge into the system.

See [docs/AGENT_ONBOARDING_AND_RECONCILIATION.md](docs/AGENT_ONBOARDING_AND_RECONCILIATION.md).

## Technology stack

### Server

- TypeScript (strict)
- Node.js, current Active LTS line
- Fastify
- Zod
- Drizzle ORM and SQL migrations
- PostgreSQL 16+ with `pgvector`, `pg_trgm`, `unaccent`
- PostgreSQL full-text search with per-language configurations
- pg-boss for PostgreSQL-backed background jobs
- Git CLI, one repository per workspace

### Web

- React single-page application built with Vite
- Served as static files by the same server process
- i18next message catalogues, English source, Russian first translation

### Agent interface

- official Model Context Protocol TypeScript SDK
- remote MCP over Streamable HTTP
- local stdio bridge shipped with the CLI

### Repository

- pnpm workspaces
- Turborepo
- Vitest, Testcontainers
- Docker / Docker Compose

### Optional AI providers

All intelligence features use a provider abstraction.

Supported classes:

- OpenAI-compatible API
- Anthropic
- Ollama
- provider disabled

The core product remains fully usable without any AI provider.

## Monorepo structure

```text
knoverge/
├── apps/
│   ├── server/        Fastify: HTTP API, MCP endpoint, static web, worker
│   ├── web/           React SPA (Vite)
│   └── cli/           knoverge CLI: bootstrap, integrity, backup, MCP stdio bridge
├── packages/
│   ├── contracts/
│   ├── core/
│   ├── db/
│   ├── git-store/
│   ├── search/
│   ├── auth/
│   ├── policy/
│   └── intelligence/
├── docs/
│   ├── adr/
│   └── i18n/
├── infra/
│   └── docker/
├── scripts/
├── CLAUDE.md
├── CONTRIBUTING.md
├── LICENSE
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

## MVP

The first usable version must include:

- workspace creation and first-admin bootstrap;
- users, workspace memberships, agent identities and API tokens;
- category hierarchy with a Git-tracked taxonomy snapshot;
- Markdown knowledge items in a self-describing Git repository;
- PostgreSQL metadata;
- Git revisions, history, diff, restore;
- append-only, keyed hash-chained event ledger;
- knowledge change feed for incremental agent sync;
- create/update/delete proposals with duplicate detection;
- policy engine with agent trust tiers;
- review inbox;
- approval/rejection/edit-and-approve;
- MCP and HTTP tools for read/search/briefing/changes/propose/supersede/proposal tracking/events;
- new-agent reconciliation protocol;
- PostgreSQL FTS + pgvector hybrid search, language-aware;
- single-container Docker Compose deployment;
- backups documented;
- basic activity digest;
- security baseline for Internet exposure (rate limits, CSRF, security headers);
- English and Russian user interface.

The MVP does **not** require:

- OAuth 2.1 for MCP clients (planned as a later milestone);
- document ingestion, audio/video transcription, image understanding (planned);
- workspace export and importers from other tools (planned);
- autonomous ontology generation;
- a graph database;
- distributed Git;
- CRDT editing;
- automatic multi-agent planning;
- enterprise SSO;
- Kubernetes.

See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the full roadmap.

## Licence

Knoverge is released under the [Apache License 2.0](LICENSE).

You may use it for any purpose, including commercial and internal use, modify it, and redistribute it under the terms of that licence.

## Support the project

Knoverge is free and open source. If it saves you time, you can buy the author a coffee:

```text
USDT (TRC20): TQgxea95dtbuaZ6cL8kLAQzeX7Mg1qzLzo
```

Thank you.

## Documentation map

- [CLAUDE.md](CLAUDE.md) - implementation instructions for Claude Code
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - system architecture
- [docs/KNOWLEDGE_MODEL.md](docs/KNOWLEDGE_MODEL.md) - knowledge structure
- [docs/GIT_REPOSITORY.md](docs/GIT_REPOSITORY.md) - workspace repository layout, frontmatter, hashing
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md) - database/domain entities
- [docs/MCP_API.md](docs/MCP_API.md) - MCP tool contract
- [docs/HTTP_API.md](docs/HTTP_API.md) - HTTP mapping of the same contract
- [docs/AGENT_ONBOARDING_AND_RECONCILIATION.md](docs/AGENT_ONBOARDING_AND_RECONCILIATION.md) - connecting agents to populated workspaces
- [docs/KNOWLEDGE_LIFECYCLE.md](docs/KNOWLEDGE_LIFECYCLE.md) - proposal/review/supersession rules
- [docs/SECURITY.md](docs/SECURITY.md) - authentication, permissions, policy, audit
- [docs/I18N.md](docs/I18N.md) - what is translated and how
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) - local/server installation
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) - build sequence
- [docs/TESTING.md](docs/TESTING.md) - required tests
- [docs/WORKFLOW.md](docs/WORKFLOW.md) - branching, commits, pull requests
- [docs/adr/](docs/adr/) - architecture decision records
