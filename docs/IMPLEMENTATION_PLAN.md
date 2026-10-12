# Implementation Plan

Build vertically and keep every milestone runnable.

## Where this is

Milestones 0 to 9 are delivered. **v0.1.0** was cut on 28 September 2026 and is the
first tagged release; **v0.2.0** added the webhooks screen. `CHANGELOG.md` says what
each one contains, and every milestone below carries the release it arrived in.

From v0.1.0 the migrations are immutable: a change to persistence is a new additive
migration with an upgrade test, never an edit to one that shipped.

Milestones 11, 12 and 13 were taken ahead of 10 and shipped in **v0.5.0**;
Milestone 10 followed in **v0.6.0**, verified against the Claude.ai connector on
a live installation. Milestone 15 arrived in **v0.7.0** and was finished in
**v0.8.0**, once a live installation had been moved off the sidecar. Milestone 14
is what remains after it, and is under way: its frame and six of its rules are
built, and the rest arrive on that frame.

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

_Delivered — v0.6.0. ADR 0038 decides the shape: an OAuth grant is an agent
credential, and consent is where a connector becomes an agent._

Delivered:

- Knoverge as OAuth 2.1 authorization server: authorization code with PKCE
  (`S256` only), rotating refresh tokens, dynamic client registration, revocation;
- the two discovery documents and the `WWW-Authenticate` challenge on `/mcp`,
  which is how a connector finds any of it;
- a consent screen where a person holding `agent.manage` binds a registered
  client to a workspace, creating the agent it will act as;
- access tokens resolving through the existing credential path, so permissions,
  policy, budgets and the ledger acquire no second case;
- expiry of clients that never completed an authorization;
- verified connection from ChatGPT and Claude.ai connectors, which needs a
  public HTTPS address.

## Milestone 11 - documents and attachments

_Delivered — v0.3.0. Storage, the record, the HTTP surface, text extraction (text,
Markdown, HTML, PDF, DOCX), the Files screen and the three MCP tools. A file that
was not read can be asked for again (v0.4.0)._

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

_Delivered — v0.4.0, except one case. An image is described by an assigned vision
model, which is also how the text in a screenshot is read, and an audio or video
file becomes what was said in it when a transcription model is assigned — an
OpenAI-compatible one, since Ollama has no endpoint that listens, and its key is
set in the interface (ADR 0033). A scanned PDF is still `unsupported`: a page
inside one has to be rendered to an image first, and rendering needs a canvas this
product does not have._

Deliver through the intelligence provider abstraction:

- audio transcription;
- video transcription;
- image description and OCR;

each producing `document` items with provenance. Providers are optional; without them media attachments are stored by reference.

## Milestone 13 - export and import

_Delivered — v0.5.0, except the ChatGPT export. `knoverge export` writes a git
bundle, a manifest and, when asked for, the attachments (ADR 0034), and
`knoverge import` puts a workspace back on another installation with its history
and provenance, adopting none of the exporting installation's people or
permissions (ADR 0035). Four ways in, all of them through a reconciliation session
rather than a blind insert (ADR 0036): a folder of Markdown, an Obsidian vault
(the same command — a vault is a folder with tags), generic JSON for the exports
nobody wrote a parser for, and `propose-from-session` for the deciding that
follows. `link-from-folder` turns the `[[wikilinks]]` between accepted notes into
relations. `adopt-commits` records what somebody committed to the repository by
hand, so editing the knowledge with an editor is a supported way to work (ADR
0037).

The ChatGPT export is deferred on purpose. The hard question in it is not parsing
but what counts as one piece of knowledge — a conversation is not a note and a
single assistant message is usually thinking out loud — and an export can be turned
into the JSON `import-json` already reads._etadata JSON) and import;
- importers producing reconciliation sessions rather than blind inserts: Markdown folder, Obsidian vault, ChatGPT export, generic JSON;
- importer for externally created Git commits.

## Milestone 14 - knowledge gardening

_In progress. ADR 0039 decides the shape: a job belongs to the core when its
finding can be computed from what is already recorded, and to the optional layer
when it rests on a judgement about meaning. ADR 0042 decides how a finding is
filed — the gardener does not ask the policy, because as the workspace's system
actor it would be told it may write. ADR 0043 decides what becomes of a finding
that names no write: it is a notice on the run, because a review queue item
nobody can approve is one that can never be cleared._

The frame and six rules are built: the per-workspace setting, the caps, the
scheduled sweep, the run record a screen can read, duplicates by content hash
and by text, the two kinds of orphan, knowledge that names no source and the
standing order that has run out. The rules below arrive one or two at a time on
the same frame.

Deliver, with no provider configured:

- **duplicates by content hash** — built. Two active items whose title and body
  are identical, with the older kept and the copy proposed for supersession;
- **duplicates by text** — built. Two active items whose bodies fold to the same
  string once capitalisation, accents and line breaks are set aside, under
  titles near enough by trigram to be one heading. It stops at equality: two
  bodies that are merely similar are a merge, and a merge needs a provider
  because what the two should become is a draft. The candidates come from the
  lexical index, because the body is in Git and in `search_chunks` and not in a
  column anything can group by — so the index proposes and the file confirms
  before anything is filed (rule 8);
- **orphan sources** — built, as two rules, because they count different things
  and a rule reports what it read. `orphan_source` is a source reference no
  revision cites at all: a row written and never attached, which in a healthy
  installation is none, every run. `orphan_attachment` is a file every one of
  whose knowledge items has been deleted — bytes kept for knowledge that is
  gone. Both are notices (ADR 0043). Neither yet sees the third case, a file
  whose document was proposed and the proposal refused, because the link from a
  proposal to the attachment is inside its payload;
- **weak provenance** — built. An active item whose current revision cites no
  source, in a workspace where more than half of its items cite one and there
  are at least ten of them. Comparative on purpose: in an installation nobody
  records provenance in, every item would be a finding, which is a rule arguing
  with a decision somebody has already made. The query returns the two counts
  and the uncited items; the rule decides whether the workspace has the habit,
  because that judgement has to be readable without a database. A notice: what
  an item should cite is not something the installation can know;
- **stale instructions** — built. An active `instruction` past the
  `valid_until` it gave itself, or unchanged for more than a year. Instructions
  only, because a `fact` and a `decision` stay true of the moment they describe
  while an instruction is what an agent reading the workspace will follow today.
  Both dates come from the domain rather than from `now()` in SQL, so the rule
  can be tested at a moment of its own choosing. A notice, and the one place a
  write is imaginable and still refused: delete, re-date or rewrite is exactly
  the choice the installation cannot make, and gardening's one proposal kind is
  a supersession by an item the workspace already holds (ADR 0039);
- taxonomy cleanup: a category with no items and no children, an alias pointing
  nowhere;
- stale summaries: dependencies have moved and the summary has not.

Deliver, only where a provider is assigned:

- duplicates by meaning, over embeddings;
- merge suggestions;
- contradictions.

Every finding that names a write is a proposal, and every finding names the rule
and the rows it rested on. The gardener gets no direct-write path at any trust
tier, and the filing path has no
branch that writes rather than a rule saying it must not (ADR 0042). Findings
are capped per rule and per run: a gardener that buries the review queue has
done harm.

What a rule leaves out it leaves out in its own query: an item with a proposal
waiting, and an item whose finding a reviewer has already refused. Filtering
those from the result instead starves a capped run, because the answered items
are the oldest and a cap takes the oldest first.

Most of the rules above produce no proposal. A source reference nothing rests
on, an item whose revisions cite nothing, a category with no items, a summary
whose dependencies have moved — none of them is a write a reviewer could
approve. ADR 0043 settles where they go: notices on the run record, with the
rule and the thing each rests on, listed by the screen. There is nothing to
approve and nothing to dismiss, because a notice is true until the thing it
describes is fixed and then it stops being reported. `findings_filed` counts
proposals only, so the run cap — which exists to keep the review queue readable
— does not stop a notice rule from being asked.

## Milestone 15 - backups you can see

_Delivered — v0.7.0 and v0.8.0. v0.7.0 carried everything but the connection
check and the removal, and the removal had to wait until a live installation had
been moved across. ADR 0040 decides the shape — a backup is a setting the product
owns, not a container in a compose profile — and ADR 0041 decides how it reaches
a second machine: the server speaks SSH itself and pins the host key it met
first._

Deliver:

- the backup taken by the application's own job runner, in the worker role,
  with the same steps and the same archive the shell script produced — database
  first, then the data directory, a manifest, and a staging name moved into
  place at the end;
- a **Data and storage** settings screen: off by default, saying so; a schedule;
  retention in days; when the last run was and whether it worked;
- an optional SSH target — host, port, user, directory, and a private key or a
  password — sealed with `KNOVERGE_ENCRYPTION_KEY`, refused outright where there
  is none, as a webhook secret already is;
- upload only: the server never lists or deletes on the far machine, and the
  screen says retention applies to local copies;
- a failing upload that does not fail the backup, and shows its last error;
- a check of the target that asks it the questions a copy would ask without
  sending one, because a screen that takes a host, a user, a directory and a key
  and then offers no way to find out whether they are right answers only after
  the first scheduled run has already failed;
- the `backup` compose profile and its two scripts removed, and the upgrade note
  that says to turn the setting on instead. The order on a live machine is: give
  the application a backups volume of its own — not the sidecar's, which belongs
  to `postgres` and is handed back to it on every start — turn the setting on,
  watch one copy arrive, and only then stop the sidecar. `docs/DEPLOYMENT.md`
  has it as steps.

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
