# Knoverge

> A knowledge ledger for humans and AI agents. Self-hosted, MCP-native, auditable.

Knoverge is an open-source, self-hosted knowledge base designed to be shared by multiple AI agents and humans through MCP and HTTP APIs.

Its purpose is not merely to provide "long-term memory". It is a **knowledge ledger**: the canonical, auditable source of durable knowledge for a person, team, project, or organisation.

Every important change is attributable to a specific actor, traceable to its source, versioned, reviewable, and reversible.

## What works today

Knoverge is at **v0.4.0**. Milestones 0 to 9, 11 and 12 of
[the plan](docs/IMPLEMENTATION_PLAN.md) are complete — 12 bar the scanned PDF —
and [CHANGELOG.md](CHANGELOG.md) says what each release contains.

- **Knowledge** — items with types, categories, tags, review and evidence state, each one a Markdown file in a Git repository with a commit per change; history, a diff per revision, logical delete and restore, and supersession as one atomic operation. Sources and relations are recorded, shown and editable, and a revision can say why it was made.
- **Agents** — an MCP endpoint at `/mcp` over Streamable HTTP, and the same twenty-nine tools at `POST /v1/<tool_name>`, from one contract. Per-credential budgets for reads, writes, inventory batches and requests in flight, and a backlog budget for proposals waiting on review.
- **Review** — agents propose, policy decides, and a person approves, edits and approves, rejects or withdraws. The review screen is a queue: it says why each proposal is waiting, what it would change against what the item says now, and what it rests on. Nothing an agent writes becomes canonical without a rule that says so.
- **Reconciliation** — a connecting agent finds out what the workspace already knows before it writes: a session, candidates matched by hash, external key and then meaning, and a run a reviewer can read as a run.
- **Finding things** — hybrid search over a chunked index: language-aware full text, trigrams, and optional embeddings fused by reciprocal rank. A compact index for reconciliation, a briefing that fits a budget, an audit feed and a change feed.
- **Time and disagreement** — a claim can say when it holds; a contradiction is recorded once and shows at both ends; evidence state is derived from the sources rather than asserted.
- **Summaries and digests** — a summary keeps the exact revisions it was made from and goes stale when one of them moves; a model can draft its text and a person saves it, and the file says which model phrased it. The activity digest has a screen, and an optional narrative of the period.
- **AI providers** — connected in the product rather than in the environment, with a wizard that probes the address, offers the models that can do the job being chosen for, and reports what one returns before it is chosen. Four jobs, each its own model: embedding, writing, looking at a picture, listening to a recording. Everything above works with none configured.
- **Files** — bring a document in through the interface, HTTP or MCP and its text becomes an ordinary knowledge item: searched, reviewed and versioned like anything else, and an agent's file goes to the review queue exactly as an agent's writing does. Text, Markdown, HTML, PDF and Word are read here, with no provider and no network. With a vision model assigned a picture is described and the text on a screenshot is read; with a transcription model an audio or video file becomes what was said in it, and the item says which model phrased it. Anything left over is kept, can be downloaded, and can be asked for again once a model that could read it is connected. The file itself stays under the hash of its contents, beside the repositories and never in Git.
- **Operating it** — one container plus PostgreSQL, a `knoverge` command line, `backup` and `restore`, `integrity check`, an exportable audit trail, ledger key rotation that keeps old events verifiable, webhooks that carry an event and never the knowledge and are added under Settings, and recovery for a write that reached Git and no further.
- **Taking it with you** — `knoverge export` writes one workspace as a git bundle plus a manifest, and the attachments when asked for. Opening it needs `git clone` and nothing from here. `knoverge import` puts it back on another installation with its history, its provenance and its taxonomy intact, and with nobody's credentials: who may write there is that installation's own decision.
- **Bringing things in** — `knoverge import-folder` offers a folder of Markdown to a workspace the way an agent offers itself: a reconciliation session that says which notes it already holds, which look familiar and which are new. Nothing is written until somebody reads that and decides; `knoverge propose-from-session` is the deciding, and what happens to each proposal is the agent's policy rather than the command's.

Not yet: OAuth for hosted connectors (Milestone 10), a scanned PDF — a page in
one has to be rendered to an image first, and nothing here renders (12), export
and import (13), knowledge gardening (14). There are no end-to-end browser
tests.

## Trying it

```bash
cp .env.example .env          # fill the four empty values: the database password
                              # and three secrets, each `openssl rand -hex 32`
docker volume create knoverge-postgres
docker volume create knoverge-data
docker compose up -d
open http://localhost:3000    # first run: the terms, the owner account, the workspace
```

The two volumes are made by hand and declared external, so `docker compose down -v`
cannot take the database and the workspace repositories with it. Nothing generates
the secrets for you: an installation that came up with a password somebody else
could guess would be worse than one that did not come up.

To run a released image instead of building from source, replace the `build` block
in `docker-compose.yml` with `image: ghcr.io/gynsus/knoverge:0.3.0`. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

The terms of use are in [TERMS.md](TERMS.md): free software, provided as is,
no telemetry, and the operator is responsible for backups and for what goes
in. The installation records which version was accepted and when.

Then create an agent under **Agents**, issue it a token, and point a client at the endpoint:

```bash
claude mcp add knoverge --transport http http://localhost:3000/mcp \
  --header "Authorization: Bearer knv_..."
```

A host that speaks only stdio runs the bridge instead:

```bash
KNOVERGE_MCP_URL=http://localhost:3000/mcp KNOVERGE_TOKEN=knv_... knoverge mcp stdio
```

`knoverge mcp check` lists the tools an endpoint offers, which answers "is the token right" before a host is configured with it.

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
│   └── adr/
├── infra/
│   ├── backup/
│   ├── caddy/
│   └── docker/
├── CHANGELOG.md
├── CLAUDE.md
├── CONTRIBUTING.md
├── LICENSE
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

## What the releases so far contain, and what they do not

v0.1.0, the first tagged release:

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

It deliberately does **not** contain:

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

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup (`nvm use`, `pnpm install`, `docker compose up -d postgres`, `pnpm dev`) and the checks to run before a pull request.

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

- [CHANGELOG.md](CHANGELOG.md) - what each release contains
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
- [docs/WEB_UI.md](docs/WEB_UI.md) - the rules the interface is built to
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) - local/server installation
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) - build sequence
- [docs/TESTING.md](docs/TESTING.md) - required tests
- [docs/WORKFLOW.md](docs/WORKFLOW.md) - branching, commits, pull requests
- [docs/CODEBASE.md](docs/CODEBASE.md) - layering, ports, transactions, ledger usage
- [docs/adr/](docs/adr/) - architecture decision records
