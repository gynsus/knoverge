# Changelog

Versions follow [Semantic Versioning](https://semver.org). A release is a tag
`vX.Y.Z` on `main`, and the image published for it is
`ghcr.io/gynsus/knoverge:X.Y.Z`.

An entry follows the Conventional Commits since the previous tag, written up so a
reader learns what changed rather than which commits landed. The v0.1.0 entry is
written by hand throughout: a generated list of everything would say "added" a
couple of hundred times and tell a reader nothing about what they are installing.

## v0.3.0 — 2026-09-28

Milestone 11: a workspace can hold the documents its knowledge came from.

### Added

- **Files.** Bring a document in through the interface, over HTTP as multipart, or
  over MCP as base64. Its text becomes an ordinary `document` knowledge item —
  searched, reviewed, versioned and superseded like anything else — and the file
  itself stays under the hash of its contents, beside the repositories and never in
  Git (ADR 0008).
- **An agent's file is not a way past review.** The item is written as the person
  or agent who uploaded the file, so an agent's document goes to the review queue
  exactly as its other writing does, duplicate check included (rule 5).
- **Text, Markdown, HTML, PDF and Word** are read, with no provider and no network
  (rule 9). A PDF with no text layer is a scan: kept and downloadable, and reading
  one is a later milestone rather than a failure now.
- **A Files screen** that leads with the state — waiting to be read, being read,
  read, waiting for review, not readable here, could not be read — explains what
  each means, and asks again by itself while the answer is still coming.
- **Three tools**: `attachment_upload`, `attachment_list` and `attachment_get`,
  defined once like every other tool, so MCP and `POST /v1/<tool_name>` are the
  same operation. The manifest reports `max_attachment_bytes`: what actually fits
  through a tool call, base64 included.
- `knoverge integrity check` reports `attachment_missing`: a row whose file is not
  in the store. An attachment is not in Git and cannot be rebuilt from anything, so
  it is the unrepairable kind.
- `.github/dependabot.yml`, which Milestone 0 asked for and nothing had done:
  packages, workflow actions and base images, weekly and grouped.

### Changed

- The line that says the job runner started names the queues it actually started,
  including webhook delivery and attachment extraction.
- The webhook form no longer redraws forty checkboxes per keystroke.
- `docs/IMPLEMENTATION_PLAN.md` says where this is: which milestones are delivered
  and in which release.
- `SPEC_INDEX.md` is gone. The README's documentation map is the only index, and a
  test fails when a document under `docs/` is missing from it.

### Compatibility

Two additive migrations. Two new configuration variables with defaults
(`KNOVERGE_ATTACHMENT_MAX_MB`, capped at 128 because an upload is held in memory
while it is hashed). Three new tools and one new field in the manifest's limits;
nothing existing changed shape.

## v0.2.0 — 2026-09-28

### Added

- **Settings → Webhooks.** Adding an endpoint no longer means a request written by
  hand inside the container. The screen leads with what leaves — an event and never
  the knowledge — then asks for the address, the event types, and whether it is
  delivering. The signing secret is shown once, with the check a receiver has to
  perform ready to copy.
- Each endpoint shows how it is going: consecutive failures, when the next attempt
  is due, and what went wrong last. All three were in the API from the first day and
  appeared on no screen, so an endpoint that stopped working stopped working
  silently.
- `webhooks.list` answers `secret_storage_configured`, and an installation without a
  `KNOVERGE_ENCRYPTION_KEY` says above the button that it cannot keep a signing
  secret rather than refusing a filled-in form.
- `next_attempt_at` on a webhook summary, so a screen can say when a failing
  endpoint will be tried again without a second copy of the backoff rule.

### Changed

- Replacing a signing secret asks for the new one, with a button that generates it.
  An update that leaves it out keeps the secret it has, so offering to replace it and
  then sending nothing would have promised something it did not do.

### Compatibility

Additive: two new fields on an existing administrative response. No schema change,
no migration, and nothing about what is delivered or how it is signed has changed.

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
