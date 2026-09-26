# Architecture

## 1. System purpose

Knoverge is a shared external knowledge layer for independent AI agents and humans.

The system must solve five different problems without conflating them:

1. canonical human-readable knowledge;
2. operational metadata;
3. audit/provenance;
4. retrieval;
5. agent synchronisation.

## 2. Logical architecture

```text
┌───────────────────────────────────────────────────────────┐
│                    Agent / Human Clients                  │
│ ChatGPT · Claude Code · OpenClaw · IDE · Browser · CLI   │
└───────────────────────────────┬───────────────────────────┘
                                │
              MCP (Streamable HTTP) / HTTPS RPC / stdio bridge
                                │
                     ┌──────────▼──────────┐
                     │   Gateway           │
                     │ auth · identity     │
                     │ rate limit · scope  │
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │   Domain Services   │
                     │ knowledge           │
                     │ taxonomy            │
                     │ proposals · policy  │
                     │ reconciliation      │
                     │ review · briefing   │
                     │ activity            │
                     └───────┬─────┬───────┘
                             │     │
                  ┌──────────▼┐   ┌▼────────────────┐
                  │ Git Store │   │ PostgreSQL       │
                  │ Markdown  │   │ metadata         │
                  │ taxonomy  │   │ event ledger     │
                  │ revisions │   │ pgvector / FTS   │
                  └───────────┘   │ jobs (pg-boss)   │
                                  └──────┬────────────┘
                                         │
                                  ┌──────▼───────────┐
                                  │ Intelligence     │
                                  │ optional         │
                                  │ embeddings       │
                                  │ summaries        │
                                  │ matching assist  │
                                  │ extraction       │
                                  └──────────────────┘
```

## 3. Runtime processes

Knoverge ships as **one application image** plus PostgreSQL. See ADR 0005.

### Server process (`apps/server`)

A single Node.js process hosts:

- HTTP API under `/v1` (RPC-style, mirrors MCP tools; plus auth and admin endpoints);
- MCP endpoint under `/mcp` (Streamable HTTP, stateless: every call carries its own credential);
- the static web bundle under `/`;
- the background worker (pg-boss consumer);
- health checks under `/health/live` and `/health/ready`.

`KNOVERGE_ROLE` controls what a process runs:

```text
all      (default) HTTP + MCP + web + worker
web      HTTP + MCP + web, no worker
worker   worker only
```

This allows a second container for jobs later without changing code.

The MCP adapter and the HTTP adapter must not implement business rules. Both call the same domain services with the same contracts from `packages/contracts`. See ADR 0003.

### Web application (`apps/web`)

React single-page application built with Vite, served as static files by the server process.

Responsibilities:

- login and session management;
- review inbox;
- knowledge browser/editor;
- taxonomy editor;
- history/diff/restore;
- agent management and token issuance;
- policy rules editor;
- activity digests;
- sync-session inspection;
- attachments (later milestone).

All strings come from message catalogues (English source, Russian first). See `I18N.md`.

### CLI (`apps/cli`)

`knoverge` command:

- `bootstrap`: first admin and first workspace;
- `ledger verify`: recomputes the event chain;
- `taxonomy`, `agent`, `permissions`, `workspace`: the administration a server
  operator may need without a browser;
- `db migrate` / `db prune` / `db recover`: the last finishes or abandons writes
  an interrupted process left behind, which is how a workspace the write guard
  has closed is opened without restarting the server;
- `integrity check` (Milestone 9): cross-store and ledger verification;
- `backup` / `restore` helpers (Milestone 9);
- `mcp stdio`: local stdio bridge that proxies to a remote Knoverge MCP endpoint with a bearer token from the environment.

### PostgreSQL

One PostgreSQL instance is sufficient for MVP.

Extensions:

- `vector`;
- `pg_trgm`;
- `unaccent`;
- `pgcrypto` if useful.

Use ordinary PostgreSQL FTS with per-language configurations before considering an external search service.

### Git store

One non-bare Git repository per workspace at `KNOVERGE_DATA_DIR/repositories/<workspace_id>`.

Git operations run through the Git CLI behind the `GitStore` interface in `packages/git-store`. See ADR 0006.

The repository is self-describing and navigable by humans. Layout, frontmatter, hashing and commit conventions are defined in `GIT_REPOSITORY.md` and ADR 0002.

Repository mutations are serialised per workspace by an in-process queue in front of a PostgreSQL advisory lock: the queue keeps waiting writers from holding connections the writer at the head still needs, and the advisory lock is what makes the exclusion hold across processes. See ADR 0012.

Every invocation names its repository explicitly and runs in an allowlisted environment with system and global configuration switched off, so neither a data directory placed inside another working tree nor an operator's own Git configuration can redirect or subvert a canonical write. See `SECURITY.md` section 13a.

### Attachment store

Original uploaded files (later milestone) live on the local filesystem under `KNOVERGE_DATA_DIR/attachments/<workspace_id>/<sha256>`, content-addressed. They are not committed to Git. Text extracted from them becomes ordinary `document` knowledge items. See ADR 0008.

## 4. Cross-store consistency

PostgreSQL and Git cannot participate in one ACID transaction.

Use a controlled write workflow.

### Commit flow

1. validate the shape of the command, as far as that needs no state;
2. acquire workspace write lock;
3. write `Operation` row in PostgreSQL with state `pending`;
4. render canonical Markdown (and `taxonomy.yaml` if the taxonomy changed);
5. commit Git revision with trailers referencing the operation;
6. update `Operation` to `git_committed` with the commit hash;
7. in one PostgreSQL transaction: write revision metadata, update item, append event, mark `Operation` as `db_committed`;
8. enqueue projection jobs (search index, embeddings, stale summaries);
9. release lock.

Everything that depends on what the workspace currently holds is read and
checked **inside** the lock, in step 4 — which item the caller is changing, the
revision it read, whether a slug is taken, whether a category is still there.
Read before the lock, the answer is a snapshot two writers can both pass: the
second then renders its file from a revision that is no longer current, claims a
revision number that is already taken, and lands a commit PostgreSQL refuses.
That leaves the workspace holding an unfinished operation and refusing every
write, which is the expensive way to discover that rule 6 was checked against
stale state. The conflict belongs in step 4, where it costs the caller a
`REVISION_CONFLICT` and the workspace nothing.

If the process crashes between Git and PostgreSQL steps, recovery logic must detect incomplete operations.

Operation states:

```text
pending
git_committed
db_committed
failed
recovered
```

A workspace holding an unfinished operation refuses to be written to. Writing on top of one would re-render the canonical file from a database that is missing what the repository already has, silently deleting a committed change and taking its version number.

Recovery runs at startup, before anything is served, and repairs what it can:

- `pending` with no matching commit: mark `failed`;
- `pending` with a commit naming it: the process died between committing and recording the hash; report for an operator.
- `git_committed` without revision row: complete the PostgreSQL side from the commit and mark `recovered`. The file at that commit carries the whole state — frontmatter for an item, `taxonomy.yaml` for the tree — because the file is the canonical record rather than a summary of one. What a file cannot carry is identity, since a path is not an id: `Knoverge-Change` names the item and revision, `Knoverge-Category` names the category and what happened to it, and the operation row carries the path it ended at and the request context the trailers do not;
- revision row without commit: impossible by construction (Git commits first), report as corruption.

An operation nobody can finish — the repository no longer has the commit it names, say, because it was restored from an older backup — is reported as unresolved, with the reason recorded on the row, and the pass carries on. It must not end the pass: recovery runs before the job runner starts and before the server reports ready, so a failure that propagates leaves an installation with no worker and permanent degraded readiness because one workspace is broken. The broken workspace keeps refusing writes, which is the correct answer for it alone.

Do not hide cross-store failure cases.

## 5. Identity model

Every request resolves to an actor.

```text
User                 instance-level human account (email, password)
WorkspaceMembership  user ↔ workspace with a role
Actor                workspace-scoped subject of audit: human | agent | system
Agent                workspace-scoped registered agent with trust tier and credentials
```

Permission grants and policy rules reference categories by stable id with `include_descendants`; paths are resolved to ids at the API boundary. Renames and merges never change access.

An agent identity is not the same as an LLM model.

Example:

```text
agent:
  id: ag_01J...
  name: Claude Code - Mac mini
  client: claude-code
  trust_tier: propose

runtime (per request):
  provider: anthropic
  model: claude-...
```

The same registered agent may use different models over time. See `SECURITY.md` and ADR 0004.

## 6. Workspace isolation

A workspace is the unit everything else hangs off: one body of knowledge, one
taxonomy, one set of members and agents, one Git repository, one event chain.
Nothing is shared between two of them, and nothing spans them — there is no
cross-workspace search, no shared category, no item that belongs to both.

That makes the right size of a workspace the size of a boundary somebody
actually wants: a client, a product, a team, a person's own notes. Splitting
one team's work across several workspaces means their agents have to be
connected to each separately and can never relate one to another. It is a
heavier boundary than a folder and a lighter one than an installation.

An installation may hold many. The first arrives with first-run setup; later
ones are created by somebody who already holds `workspace.admin`, from the
switcher in the interface or with `knoverge workspace create`. Creating one
makes the creator its owner and leaves every other workspace untouched.

All knowledge belongs to a workspace.

All major database tables include `workspace_id`.

Git repositories and attachment directories are workspace-scoped.

Never rely only on application filtering. Repository methods must require workspace context explicitly.

Agent credentials are bound to exactly one workspace. A human user may be a member of several workspaces.

## 7. Taxonomy

A workspace has a versioned taxonomy.

Taxonomy entities are categories, not arbitrary folders.

Categories contain:

- id;
- slug path;
- name;
- description;
- parent;
- inclusion guidance;
- exclusion guidance;
- aliases;
- status;
- created/approved provenance.

The taxonomy is also written to `taxonomy.yaml` in the workspace repository on every taxonomy change, so the repository can be interpreted without the database.

Agents may query categories and propose new ones.

Agents should not create categories merely because a different wording exists.

See `KNOWLEDGE_MODEL.md`.

## 8. Retrieval architecture

Canonical Markdown is never split, but retrieval works on derived **search chunks**: a deterministic paragraph-based splitter produces one or more chunks per revision, each with its own FTS vector and embedding. Short items have one chunk. Search aggregates chunk scores to items and returns the best chunk with each result, which keeps long `document` and `procedure` items searchable and embeddable.

Retrieval uses multiple independent signals.

Initial hybrid ranking:

```text
lexical relevance   (language-aware FTS + trigram, per chunk)
semantic similarity (pgvector over chunks, optional)
category proximity
relation proximity
trust score        (computed from review, evidence, dispute)
freshness
```

Weights are configuration, not hard-coded product truth.

MVP may start with lexical + vector + trust score/freshness.

Search result must include enough metadata to let the caller decide whether to fetch canonical content.

Each item carries a `language`; the FTS vector is built with the matching PostgreSQL configuration (`english`, `russian`, ... falling back to `simple`).

Embeddings are produced under one active **embedding profile** per workspace (provider, model, dimensions). Changing the profile triggers a full background rebuild; the old profile stays queryable until the rebuild completes.

## 9. Briefing

Agents starting a session should not page through the whole index.

`knowledge_briefing` returns a compact, token-budgeted pack for a category subtree:

- active `instruction`, `preference`, `decision` items in full or abridged form;
- recent `observation`/`episode` headlines;
- open conflicts and pending proposals relevant to the subtree;
- revision ids and content hashes so the agent can propose updates safely;
- the current `change_sequence` so the agent can later call `knowledge_changes`.

Briefings are assembled deterministically from canonical data; no LLM is required. An optional LLM may compress the pack under a budget in later milestones.

## 9a. Audit feed and change feed

The event ledger (ADR 0007) feeds two read APIs:

- `events_list`, the audit feed: every event, gated by `events.read_own` / `events.read_all`, shows actors;
- `knowledge_changes`, the change feed: knowledge, relation and taxonomy changes only, gated by the caller's `knowledge.read` scope through a category id snapshot on each event, shows no actors.

Both use the per-workspace integer `sequence` as cursor. Agents synchronise with the change feed; the audit feed is for humans and auditors. See ADR 0010.

## 10. Knowledge graph

Do not require a graph database in MVP.

Represent relations in PostgreSQL and in frontmatter:

```text
knowledge_relation
  from_item_id
  relation_type
  to_item_id
  valid_from
  valid_until
```

Relation types:

```text
relates_to
depends_on
supersedes
contradicts
supports
derived_from
implements
mentions
```

If a specialised graph engine is added later, it must be an optional index/projection.

## 11. Background jobs

Use pg-boss (PostgreSQL-backed) in MVP.

Jobs:

- search index update;
- embedding generation and profile rebuild;
- semantic matching for sync candidates;
- summary generation;
- taxonomy duplicate checks;
- digest generation;
- webhook delivery;
- integrity checks;
- attachment text extraction (later);
- transcription and image description (later).

Do not require Redis for the first release.

## 12. Observability

Application logs must include:

- request id;
- workspace id;
- actor id;
- agent id when applicable;
- operation;
- duration;
- error code.

Never log:

- bearer tokens;
- passwords or session cookies;
- secrets;
- raw private knowledge by default.

Provide `/health/live` and `/health/ready`.

No telemetry leaves the installation.

## 13. Backup boundary

A recoverable installation requires:

1. PostgreSQL backup;
2. `KNOVERGE_DATA_DIR` (workspace Git repositories and attachments);
3. encryption/configuration secrets kept separately.

Search indexes and embeddings are rebuildable and are not required for authoritative backup.
