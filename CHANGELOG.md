# Changelog

Versions follow [Semantic Versioning](https://semver.org). A release is a tag
`vX.Y.Z` on `main`, and the image published for it is
`ghcr.io/gynsus/knoverge:X.Y.Z`.

From v0.2.0 on, entries here are generated from the Conventional Commits since the
previous tag and hand-edited only for the release summary. This first one is
written by hand: a generated list of everything would say "added" a couple of
hundred times and tell a reader nothing about what they are installing.

## v0.1.0 — 2026-09-28

The first tagged release. Knoverge is a self-hosted knowledge base that humans and
AI agents share: agents propose, people decide, and every material change is a Git
commit and an entry in a keyed hash-chained ledger.

A complete installation is one application container and PostgreSQL. Nothing else
is required, and nothing leaves the installation unless an operator configures it
to.

### Canonical knowledge

- Knowledge items are Markdown files with YAML frontmatter in a Git repository, one
  repository per workspace, filed under their category path. A `git clone` and a
  text editor are enough to read the whole knowledge base without this software.
- Every change is a revision and a commit, including a change to metadata alone.
  The commit message names the operation, the workspace, the actor, the agent and
  the proposal, and carries one `Knoverge-Change` trailer per revision it produced.
- Ten item types, one assertion each for the four that hold assertions. Sources and
  relations are recorded in PostgreSQL for queries and mirrored into the file as the
  portable copy.
- Updates carry the revision and content hash they were based on; a stale write is a
  `REVISION_CONFLICT` naming the current ones, never an overwrite.
- Deleting is logical, history is a first-class read — revisions, diff between any
  two, restore — and a write that reached Git but not PostgreSQL finishes itself at
  the next start.
- Validity in time (`valid_from`, `valid_until`, `observed_at`), so a replacement is
  not read as a disagreement; disputes are derived from a live `contradicts`
  relation and marked at both ends; evidence state is derived from the sources,
  `corroborated` when two of them come from different origins.
- Summaries keep the exact revisions they were made from and go stale by arithmetic
  rather than by a flag, and `drafted_by` names the model that phrased a revision's
  text when one did.

### Agents, policy and review

- Agents are identities with bearer credentials: the token is shown once and stored
  only as a peppered hash. Trust tiers describe the agent, never grant anything.
- Without an explicit `allow_direct` rule every agent write becomes a proposal,
  including for a `trusted` agent; a `deny` creates nothing and is recorded.
- Four kinds of proposal — create, update, delete, supersede — with review,
  approval with a reviewer's edits, rejection with a reason and withdrawal by the
  proposer. Nobody decides their own proposal.
- Permission grants and policy rules scope by category id with descendants, never by
  path; a grant cannot hand out more than the granter holds.
- Duplicate detection on the way in: external key, content hash, similar title by
  trigram, near meaning by vector. A proposer may acknowledge what they ruled out.

### MCP and HTTP

- 26 tools defined once in `packages/contracts`; MCP exposes them as tools and HTTP
  as `POST /v1/<tool_name>` over the same handlers. Administration is deliberately
  not a tool.
- MCP over Streamable HTTP, with provenance in the call's `_meta` — client, model,
  session — where HTTP would use headers.
- An OpenAPI document generated from the same schemas, describing the refusals as
  well as the answers, and a `knoverge mcp` stdio bridge for hosts that speak no
  HTTP.
- Per-credential budgets for reads, writes, inventory batches and requests in
  flight, plus a backlog budget a rate cannot express: 200 proposals waiting for one
  actor. `workspace_manifest` reports all of them so a client can pace itself.

### Reconciliation

- A sync session with a checkpoint, an inventory submitted in batches and six
  matching steps — external key, content hash, deterministic metadata, lexical,
  semantic, freshness — so a newly connected agent does not re-record what the
  workspace already holds. A match outside the caller's read scope is not a match.

### Search

- Deterministic chunking, per-language full-text search with `unaccent` and
  trigrams, optional embeddings, and the two rankings fused by position. The index
  is a projection and is rebuilt from the files, never repaired.

### Optional model features

- Embeddings, summary drafting and an optional narrative for the activity digest.
  Each is configured in the product rather than in the environment, and the core
  runs with every provider disabled: search stays lexical and nothing is contacted.

### Operations

- `knoverge` command line: bootstrap, database migrate/status/prune/recover/reindex,
  workspaces, taxonomy, agents and credentials, `backup`, `restore`,
  `integrity check`, `ledger verify` and `keys`, `audit export` and `verify`.
- The event ledger is append-only in the database itself: triggers refuse `UPDATE`,
  `DELETE` and `TRUNCATE`, and each event is keyed-hashed over the previous hash.
  A ledger key is retired rather than replaced, so what it signed still verifies.
- Webhooks deliver an event and never an object, signed with a secret sealed with
  `KNOVERGE_ENCRYPTION_KEY`.
- `integrity check` reports ten kinds of disagreement, from an unfinished operation
  and a broken hash chain to a missing file, a content or frontmatter hash that does
  not match, a taxonomy that disagrees with the tree, and a commit the database has
  never heard of.
- Docker Compose with the database and application volumes declared external, so
  `docker compose down -v` cannot take a knowledge base with it; optional backup and
  Caddy profiles.

### The web interface

- Seventeen screens: knowledge, review, taxonomy, sync, agents, policy, workspaces,
  the ledger with the activity digest, settings and first-run setup.
- Every string goes through the English and Russian catalogues, and CI fails if the
  two disagree.

### Known limits

- Webhooks are configured through the API or the command line; they have no screen.
- There are no end-to-end browser tests yet: the interface is covered by component
  tests and by the HTTP tests behind it.
- OAuth for hosted MCP clients, attachments and documents, media understanding,
  export/import and knowledge gardening are not started. They are the next
  milestones, in that order.

### Migration policy

The migrations in this release are the baseline. From here they are immutable:
every change to persistence is a new additive migration with an upgrade test.
