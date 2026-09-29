# Changelog

Versions follow [Semantic Versioning](https://semver.org). A release is a tag
`vX.Y.Z` on `main`, and the image published for it is
`ghcr.io/gynsus/knoverge:X.Y.Z`.

An entry follows the Conventional Commits since the previous tag, written up so a
reader learns what changed rather than which commits landed. The v0.1.0 entry is
written by hand throughout: a generated list of everything would say "added" a
couple of hundred times and tell a reader nothing about what they are installing.

## Unreleased

Milestone 10: a hosted connector can let itself in, once a person says so.

### Added

- **Knoverge is its own OAuth 2.1 authorization server** (ADR 0038), because
  ChatGPT and Claude.ai cannot be handed a pasted token. A connector given
  nothing but the `/mcp` address finds the rest for itself: an unauthenticated
  call answers `401` with a `WWW-Authenticate` header naming the protected
  resource document, which names the authorization server, which names its
  endpoints. Dynamic client registration is open and grants nothing — a
  registration holds no workspace, no agent, no permission and no token.
- **Consent is where a connector becomes an agent.** A person signs in, holds
  `agent.manage` in the workspace they pick, and says yes; that creates the
  agent the connector acts as, at the tier every agent starts at. It then sits
  on the Agents screen beside every agent created by hand, and the connection
  can be ended there, which revokes every token it issued. Consenting again
  resumes the same connection rather than making a second actor, so a person
  who reconnects three times is one name in the ledger.
- **The consent screen names two things and says which is which.** The
  connector's own `client_name`, chosen by whoever registered it, and the host
  the token would actually go to — the one part of the request its author
  cannot misrepresent.
- **An access token is an ordinary agent credential**, with a shorter life and
  the id of the grant that issued it. Nothing downstream of authentication has
  a second case: the same permission checks, the same policy, the same budgets,
  the same ledger.

### Security

- Authorization codes are spent by the first exchange whether or not that
  exchange succeeded, so a stolen code buys no attempts at the verifier.
- Refresh tokens rotate, and one presented twice revokes the whole grant: being
  able to notice a captured token is not the same as doing something about it.
- A redirect URI that does not match a registration is refused without a
  redirect, because answering an unmatched URI is the open redirection the
  specification warns about.
- Client ID Metadata Documents are deliberately not supported: honouring one
  means fetching a URL an unauthenticated caller chose, which rule 12 forbids.

### Fixed

- **A token issued by consent was not recorded in the ledger.** ADR 0038 says a
  consent creates an agent and issues a credential, and that both are ordinary
  events; the code recorded only the first. Found by connecting a real
  connector and reading the feed afterwards. The token a refresh produces stays
  out, which is what rule 4 says about authentications.
- **Signing in dropped the query string of the page you were sent to.** Only
  the path was kept, and an authorization request is a page whose query *is*
  the request, so somebody not signed in came back to a consent screen with
  nothing to consent to.

### Compatibility

One migration, additive. No new configuration: the authorization server calls
itself whatever `KNOVERGE_BASE_URL` says, which an installation reachable from
the internet already had to set correctly.

## v0.5.0 — 2026-09-29

Milestone 13: knowledge can be taken somewhere else, brought in from somewhere
else, and edited without this product at all.

### Added

- **`knoverge export`** writes one workspace as a git bundle, a manifest and, when
  asked for, its attachments. Opening it takes `git clone` and nothing from here:
  the bundle is the repository, with the Markdown, the taxonomy and every revision
  as a commit. The manifest adds what the files cannot say — the workspace's slug,
  where the ledger stood, and the display name of each actor the commits name —
  and carries nobody's address. What it leaves out it leaves out on purpose:
  credentials, permissions, proposals and the event ledger belong to the
  installation that made them (ADR 0034).
- **`knoverge import`** puts it back on another installation, with its history.
  The commits are walked oldest first, so a workspace that was imported reads like
  one that was used: history answers, a diff between any two revisions works, a
  summary knows what it was made from. Actors are recreated with their names and
  nothing behind them — the interface still says who wrote something, and nobody
  gains the ability to sign in or write again. Item ids survive, which makes it a
  move rather than a second copy: an installation that still holds those items
  refuses the import and names the ids (ADR 0035).
- **A folder of Markdown arrives as a reconciliation session**, not as an insert.
  `knoverge import-folder` opens a session as an agent, submits a compact
  inventory — a title, a type and two fingerprints, never the text — and reads
  back which notes the workspace already holds, which look familiar and which are
  new. Nothing is written until somebody reads that (ADR 0036).
- **`knoverge propose-from-session`** is the deciding that follows. Only
  `new_candidate`, each file re-read and checked against the fingerprint the
  session recorded, and what happens to each proposal is the agent's policy rather
  than the command's.
- **An Obsidian vault is the same command.** A vault is a folder of Markdown with
  tags, and tags come across from both places people write them: `tags:` in the
  frontmatter and `#tag` in the text.
- **`knoverge link-from-folder`** turns the `[[wikilinks]]` between accepted notes
  into relations, so a vault arrives as the graph it was rather than as a thousand
  loose notes. Every link becomes `relates_to`, because that is all a wiki link
  claims.
- **`knoverge import-json`** is the path for the exports nobody wrote a parser
  for: a Notion export, a wiki dump, somebody's script. Forgiving about what
  fields are called and strict about what a record has to be.
- **`knoverge adopt-commits`** records what somebody committed to the repository
  by hand. Rule 1 says the knowledge is editable without this product; until now
  the answer to a commit made by hand was `head_unknown` and nothing else. The
  file says which item it is, through the id in its frontmatter (ADR 0037).

### Fixed

- **Recovery lost the provenance of a revision it rebuilt.** A write that reached
  Git and no further was rebuilt from its commit with its categories, tags, search
  index, relations and summary dependencies — and without `source_references`. So
  a recovered item cited a page in its own frontmatter while the database said
  nothing rested on it, and "which items came out of this attachment" answered
  nothing. Found while starting the import, which rebuilds the same way.
- **The frontmatter parser required three fields the specification calls
  optional.** `GIT_REPOSITORY.md` names seven required fields; `review`, `evidence`
  and `disputed` were also demanded, so a file a person wrote in an editor was
  refused. They are defaulted now, and each default is what its absence means.

### Guards

- Every command the code defines is asserted to appear in the deployment guide: a
  command nobody documented is a command nobody runs.

### Compatibility

No migrations, no new configuration. Everything added is a command line
operation; nothing existing changed shape.

## v0.4.0 — 2026-09-28

Milestone 12: a workspace can read what its files say, whatever they are.

### Added

- **Pictures become knowledge.** With a vision model assigned, an image is
  described and the text on a screenshot or a photographed page is read out, and
  what comes back is an ordinary `document` item with the attachment it came from
  as its source. `drafted_by` names the model on the file itself, because a
  description is a model's words about somebody's picture (ADR 0031).
- **Recordings become knowledge.** With a transcription model assigned, an audio
  or video file becomes what was said in it. The file goes as it arrived and under
  its own name — a container this product cannot open is one a transcription
  server opens every day — and nothing is said about the language, because a
  workspace's own language is a guess about somebody else's recording.
- **Two more purposes on the settings page**, each its own model, each connected
  and stopped on its own. Transcription is offered only from the providers that
  could answer it: Ollama has no endpoint that takes a recording, and the page
  says so rather than letting somebody assign a model that can never be asked.
- **A probe for vision**: a red square on white, a hundred and forty-six bytes,
  drawn here rather than fetched from anywhere (rule 12). The screen shows what
  the model said about it, because a catalogue never says which models can see.
  Transcription has no probe, and the wizard says so outright: speech is the one
  thing that cannot be made up here, and a synthesised clip would test the
  synthesiser.
- **An API key is set in the interface**, for the one kind of provider that has
  any use for one. Sealed with `KNOVERGE_ENCRYPTION_KEY` exactly as a webhook's
  signing secret is, write-only, and never shown again: the page says whether a
  provider has one, never which (ADR 0033). Without an encryption key the field is
  not offered and the server refuses rather than storing in clear.
- **A file that was not read can be read again.** The sweep only looks at files
  nobody has read yet, so a model assigned today could never reach a file that
  arrived last month, and a provider unreachable for a minute left a file `failed`
  for good. `attachments.reread` takes one file or every `unsupported` and
  `failed` file in the workspace, with a button on the Files screen for each.
- **ADR 0032**, which records what Milestone 12 decided and had not written down:
  text a model produced about an uploaded file is written without a person reading
  it first, and what makes that safe enough is not the model.

### Fixed

- **A vision model could never be assigned.** `ai_assignments_purpose_check` still
  listed the two purposes that existed when the table was written, so `ai.assign`
  answered `INTERNAL_ERROR`. The vision half of Milestone 12 had never worked in
  the product; it reached `main` and no tagged release.
- **A claim could expire mid-transcription.** The window a file's claim is believed
  for was ten minutes, chosen when the longest a file could take was reading a PDF.
  A transcription provider is given ten minutes before it is given up on, so the
  next sweep could take a file still being transcribed: the same recording paid for
  twice, and two documents from it. Half an hour now, and the relationship between
  the two numbers is a test.
- **The wizard opened a purpose on the wrong model.** Pressing Change on the vision
  row pre-filled whatever the embedding model was.
- **A replaced provider key was noticed by one process only.** The built provider
  is cached, and the sealed key is now part of what it is cached by, so a worker
  does not keep calling with a revoked credential until a restart.
- **The wizard would not connect an OpenAI-compatible provider at all**, which left
  transcription reachable only if the embedding provider happened to be one.

### Changed

- `SECURITY.md` says where a model's words do reach the repository without
  somebody reading them first, and that an assigned vision or transcription model
  is sent the bytes of an uploaded file — not only text.
- The Files screen's "not readable here" no longer calls a picture a kind of file
  nothing here reads. It says what to connect, and which case is still out of
  reach.
- The README said twenty-six tools when there were twenty-nine.
- `docs/DATA_MODEL.md` has a section for the AI tables, which had none.

### Guards

- Every `CHECK` constraint listing values is asserted against its contract enum —
  twenty-three columns — because a `CHECK` and a `z.enum` are one list written
  twice, and that is how the vision purpose reached `main` unable to be assigned.
- The README's tool count is checked against the contract.

### Compatibility

Two additive migrations. No configuration is required: with no vision or
transcription model assigned, files behave exactly as they did in v0.3.0.
`KNOVERGE_EMBEDDING_API_KEY` still works and is the fallback for the address it
names. Two new fields on the AI settings response and one on a provider; nothing
existing changed shape.

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
