# Changelog

Versions follow [Semantic Versioning](https://semver.org). A release is a tag
`vX.Y.Z` on `main`, and the image published for it is
`ghcr.io/gynsus/knoverge:X.Y.Z`.

An entry follows the Conventional Commits since the previous tag, written up so a
reader learns what changed rather than which commits landed. The v0.1.0 entry is
written by hand throughout: a generated list of everything would say "added" a
couple of hundred times and tell a reader nothing about what they are installing.

## v0.9.0 — 2026-10-12

Milestone 14 opens. A workspace can read its own knowledge on a schedule and say
what it noticed — and it never writes: a finding that names a write is a
proposal for review, and one that names none is a notice on the run.

### Added

- **Gardening, per workspace and off until somebody turns it on.** A schedule in
  hours, a cap on findings per run and another per rule, a record of every run
  and a screen that reads it. A workspace is the unit of knowledge and of
  review, so it is the unit of tidying; off by default because the first thing
  gardening does is make work for a person, and capped because a gardener that
  buries the review queue has done harm rather than work.
- **The gardener files and does not ask** (ADR 0042). It runs as the workspace's
  system actor, the only actor an installation owns — and a system actor is the
  host operator at the command line, whose default policy effect is
  `allow_direct`. A gardener that proposed the way an agent proposes would have
  been told it may write and would have tidied the knowledge base without asking
  anybody. So filing a finding is a second entry point on the proposal service
  where the decision is fixed at `require_review` rather than read, and there is
  no argument it can be called with that writes: the `apply` closure it hands
  over is only ever run by an approval.
- **Duplicates by content hash.** Two active items whose current content hash is
  identical — the same words under the same heading twice, because the hash
  covers the title and the body and no metadata. The older is kept: the
  relations and sources that exist point at it, its history is the longer one,
  and the copy is the thing that happened afterwards.
- **Duplicates by text**, which is what that misses. The content hash rests on
  the normalisation the file format needs — line endings, trailing spaces, runs
  of blank lines — and nothing else, so "Auth strategy" and "Auth Strategy" over
  one identical body are two items to it. This folds capitalisation, accents and
  where the lines broke as well, and asks of the titles only that they be near
  enough by trigram to be one heading. It stops at equality: bodies that are
  merely similar are a merge, and a merge needs a provider, because what two
  nearly-identical items should become is a draft.
- **A finding that names no write is a notice** (ADR 0043). Four of the rules
  this milestone owes name no write anybody could approve, and a review queue
  item nobody can approve is one that can never be cleared. So they are recorded
  on the run that found them, with the rule and the thing each rests on. Nothing
  to approve and nothing to dismiss: a notice is true until the thing it
  describes is fixed, and then a later run stops reporting it.
- **Two notice rules.** `orphan_source` is a source reference no revision cites
  at all — a row written and never attached, which in a healthy installation is
  none, every run. `orphan_attachment` is a file every one of whose knowledge
  items has been deleted: bytes kept for knowledge that is gone. Neither has a
  button that fixes it, and the ADR says so rather than making the rules wait
  for one.
- **An hourly sweep** in the worker role, which asks which workspaces are due
  and usually finds none, because the interval is the workspace's setting and
  the schedule is not. Registered whether or not any workspace gardens, for the
  reason the backup queue is.
- **A README version the tests hold to the changelog.** The image line was
  guarded and the sentence above it was not, so the README said v0.7.0 while it
  offered the 0.8.0 image.

### Changed

- **The run record says what each rule did**, not whether gardening is on: from
  the review queue, a rule that found nothing and a rule that never ran look
  identical. `findings_filed` counts proposals only, so the run cap — which
  exists to keep the review queue readable — never stops a notice rule from
  being asked.
- **What a rule leaves out it leaves out in its own query**: an item a reviewer
  is already holding, and an item whose finding this gardener had refused.
  Filtering those from the result instead starves a capped run, because the
  answered items are the oldest and a cap takes the oldest first. A test found
  that, not a reading of the code.

### Verified

- 1398 tests, and a deliberate break for every claim each new one makes. Two
  breaks were initially missed and both were gaps in the tests rather than in
  the code; one break found a real defect before any of it, where a whitespace
  class inside a template literal reached PostgreSQL as a letter.
- On the stand: migrations applying themselves on start, the new queue
  registered, the screen refusing anybody without `workspace.admin`, and a run
  that filed a proposal and changed nothing.

### Compatibility

Two additive migrations, `0026_gardening` and `0027_gardening_notices`. They
create the settings and run tables and add one column; nothing existing is
altered and no row is backfilled, because a workspace with no settings row has
the defaults, which is gardening off. Upgrading from v0.8.0 needs the new image
and nothing else, and an installation that never turns gardening on behaves
exactly as it did.

## v0.8.0 — 2026-10-11

The last step of Milestone 15, and the screen's missing answer. An operator can
ask the backup target whether a copy would arrive, and the second container that
used to take the copies is gone from the product.

### Added

- **Asking the target whether a copy would arrive.** The storage screen offered
  a host, a user, a directory and a key, and no way to find out whether any of
  it was right: the first answer came from a scheduled run, which is a
  consequence after the click rather than before it (`docs/WEB_UI.md` rule 4).
  **Check the connection** makes the connection an upload makes, carrying no
  file — one `connect` for both, because a check built on a second way of
  reaching the target would rehearse something else, and the same single
  authentication method, verifier, timeouts and pin are the point.
- **Three stages rather than one verdict**, because the server has three and
  they are fixed in three different places: the address and the credential are
  settings here, the directory is somebody else's machine, and a directory that
  exists and refuses a file is that machine's permissions. A stage after a
  failure says it was not reached, instead of showing a cross that would send
  somebody to fix permissions on a directory nothing opened.
- **The check writes a byte and removes it.** Whether a directory accepts a file
  cannot be learned by looking at it, and a check that only looked would pass
  where the upload fails. If the removal does not succeed, the check says so and
  names what it left behind.
- **Upgrading an installation that is already running**, in
  `docs/DEPLOYMENT.md` §12: the copy to take first and why `--keep-days 3650`
  belongs in that one command, and what to do when an upgrade has to be undone.

### Changed

- **The sidecar is gone.** The `backup` compose service,
  `infra/backup/backup.sh`, `infra/backup/loop.sh`, and
  `KNOVERGE_BACKUP_INTERVAL` and `KNOVERGE_BACKUP_KEEP` with them. What took
  copies was a shell script that could not reach the write locks, so a write in
  flight landed on one side of its archive and not the other; what takes them
  now holds every workspace's lock across the dump and the archive, and the two
  describe one moment. A complete installation is one application container plus
  PostgreSQL again (rule 10).
- **The check reads what is saved, not what is typed.** The secret is sealed and
  never returns to the browser, so the button is refused with a reason until the
  target has been stored. It is not a run either: `last_run_at` and the upload
  fields are left alone, because a check is not a copy.
- **Both workflows name `ubuntu-24.04`** instead of `ubuntu-latest`, which moves
  to a new Ubuntu release on a date GitHub picks — 19 October 2026 for Ubuntu
  26. A guard refuses any `runs-on` label ending in `-latest`.

### Fixed

- **Two paragraphs of the deployment guide argued from the sidecar's
  existence** and were wrong the moment it went: taking a copy on demand was
  contrasted with a scheduled service that could not hold the locks, and the
  dump order was presented as the thing that makes a copy consistent. They are
  one mechanism now, the order is still kept, and the reason it is kept is
  written down rather than implied.

### Verified

- Against the live installation at `knoverge.njsoft.dev`: the schedule took a
  copy, it reached the second machine over SFTP, and the sidecar was stopped,
  removed, and taken out of the compose file with the application still serving.
- The check's stages against a real in-process SFTP server: every stage passing
  and nothing left behind, a wrong credential, a missing directory, a directory
  that exists and refuses the file, a pin that matches, a pin that does not, and
  nothing listening at all.

### Compatibility

No migrations: this release adds no columns and reads the ones v0.7.0 shipped.
Upgrading from v0.7.0 needs the new image and nothing else.

An installation still running the sidecar has to stop and remove that container
before pulling this version, because the service mounts two shell scripts this
repository no longer contains. `docs/DEPLOYMENT.md` §9 keeps the migration as an
upgrade note for exactly that reader. `KNOVERGE_BACKUP_INTERVAL` and
`KNOVERGE_BACKUP_KEEP` are no longer read by anything and can be deleted from
`.env`.

## v0.7.0 — 2026-10-11

Milestone 15 bar its last step: an installation keeps copies of itself because
somebody turned that on in Settings, not because they started a second
container. ADR 0040 decides the shape, and ADR 0041 decides what speaks SSH when
a copy is to reach a second machine.

### Added

- **A backup is a setting the product owns** (ADR 0040). The copy is taken by
  the application's own job runner in the worker role, and it is the same
  archive the shell script produced: the database first, then the data
  directory, a manifest recording where each workspace's ledger stood, every
  workspace's write lock held across both, and a staging name moved into place
  at the end so that a half-written copy is never a copy. Off until somebody
  turns it on, and the screen says so.
- **A Data and storage screen.** Whether to keep copies, how often, how many
  days to keep them, what the last run did and when, and the copies on disk with
  their sizes. **Take one now** sits beside the schedule, because an operator who
  has just configured this wants to watch one happen rather than wait a day to
  find out whether it works.
- **One SSH target, and the server only ever writes to it.** Host, port, user,
  directory, and a private key or a password, sealed with
  `KNOVERGE_ENCRYPTION_KEY` and refused outright where there is none, as a
  webhook secret already is. Nothing on the far machine is listed or removed by
  us, so retention applies to local copies, and the screen says that where the
  number is typed.
- **The server speaks SSH itself** (ADR 0041), over SFTP, so the account at the
  far end needs no shell and the sealed key never has to become a file for
  OpenSSH to read. The host key is pinned the first time the target answers, and
  shown as a `SHA256:…` fingerprint beside the `ssh-keyscan` line that prints the
  same thing on the operator's own machine, to be compared by eye.
- **Forgetting a pinned host key**, for a machine that was rebuilt rather than
  impersonated. Its own action rather than a side effect of saving, behind a
  dialogue that says what it widens and when not to use it; the log keeps the
  fingerprint that was trusted, because the column that held it is empty
  afterwards and nothing else records it.
- **An upload that fails does not fail the backup.** The local copy is a backup,
  the next run tries again, and each copy carries whether it left the machine.
- `KNOVERGE_BACKUP_DIR`, and a refusal to start when it is inside
  `KNOVERGE_DATA_DIR` or the other way round. The archive is made of the data
  directory, so a copy kept there would be inside the next one: the copies would
  double, `tar` would read a file that is being written, and the screen would
  report success throughout.

### Changed

- `knoverge backup` on the command line and the scheduled job are one mechanism
  rather than two. Two implementations would have been two formats to restore.
- `knoverge restore` names the clients it is refusing to run beside — the
  application name and the state PostgreSQL holds for each — instead of counting
  them. A refusal reading `1 other client(s) are connected` left an operator to
  guess which one.
- The Node line is pinned to the Active LTS line and the configuration now says
  so, so the next person to read it does not have to infer the policy from a
  version number.

### Fixed

- **The documentation offered `ghcr.io/gynsus/knoverge:0.3.0` in four places
  while `0.6.0` was out** — three releases of fixes a reader following
  `README.md` or `docs/DEPLOYMENT.md` would not have received.
- **A fresh installation could not take a copy at all.** The image creates
  `/data` and gives it to the user it runs as, and never did the same for
  `/backups` — so Docker created that mount point itself, owned by root, and the
  process was refused by it. Pressing **Take one now** answered
  `EACCES: permission denied, mkdir '/backups/…'`, which named neither the user
  nor anything to do about it. The image now contains both directories owned by
  the user it runs as, which also decides the ownership of an empty volume, and
  `KNOVERGE_BACKUP_DIR` defaults to `/backups` there for the same reason
  `KNOVERGE_DATA_DIR` defaults to `/data`. A directory this cannot fix — one the
  sidecar wrote to, which belongs to `postgres` and is handed back to it on
  every start — now gets a sentence naming both uids and the remedy, said before
  any workspace lock is taken.
- **The quickstart did not create every volume the compose file requires.**
  Copies were given a volume of their own, external like the other two, and
  Compose will not invent a volume it is told is external — so
  `docker compose up` ended at `external volume "knoverge-backups" not found` on
  a machine where nothing was running yet and nothing to read the cause from.
  Both documents now create all three.

### Guards

- The external volumes are read out of `docker-compose.yml` and each one is
  looked for as a `docker volume create` line in both `README.md` and
  `docs/DEPLOYMENT.md`, because the compose file and the instructions for using
  it are one list written twice.
- Every image pinned in those two documents is compared against the newest entry
  in this file, so a release cannot be cut while they name an older one.
- Every literal `t('…')` key in the web application is resolved against the
  English catalogue, plural categories included. A key that does not exist
  renders its own name on screen, which no test written from the code notices;
  one reached a branch that way.

### Verified

Both defects above were found by following the documentation on a machine with
nothing on it and by opening a shell in the container, not by a test. The suite
takes its copies into a directory the test process owns and reads its documents
as text, so it agreed with the code — which is what tests written from the code
do. The quickstart has since been run from an empty project, and a copy taken in
the container against a volume mounted the way the compose file mounts one.

### Compatibility

Two migrations, additive. `KNOVERGE_BACKUP_DIR` has a default, so an
installation upgrades without being reconfigured — but with no volume mounted
there the copies land inside the container and go when it does, which is why the
compose file in this repository mounts one.

The `backup` compose profile and its two scripts are still here and still work.
An installation running that sidecar cannot share its directory with the
application — the sidecar runs as `postgres` and takes the directory back on
every start, and the application runs as `node` — so the move across is: give
the application a backups volume of its own, turn the setting on, watch one copy
arrive, and only then stop the sidecar. `docs/DEPLOYMENT.md` has it as numbered
steps and says which order leaves an installation taking no copies at all. The
profile is removed in a later release, once nothing is relying on it.

## v0.6.0 — 2026-09-30

Milestone 10: a hosted connector can let itself in, once a person says so. With
this the plan's milestones 0 to 13 are delivered.

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

- **Reconnecting a connector made a second one beside it.** A hosted client
  registers itself again every time it is reconnected, so it arrived under a
  new client id and became a new agent — while the connection it had stayed
  live, with a working refresh token, because disconnecting in the connector
  does not call this server's revocation endpoint. A person who reconnected
  twice had three agents and two connections they could not see without going
  looking. Consent now recognises a returning connector by the name it calls
  itself and the addresses it accepts a code at, keeps the agent it already
  was, and retires the connection it is replacing — which the consent screen
  names first — and every live connection it holds goes, not the newest of them,
  because one left behind is a working refresh token nobody can see. Found by
  reconnecting a real connector and reading the tables afterwards.
- **Disabling an agent did not end its OAuth connections.** Its credentials
  were revoked and its grant was not, so the connector went on exchanging its
  refresh token for access tokens that failed every call — and re-enabling the
  agent brought the connection back with nobody having consented again, which a
  pasted credential never does. Found by auditing the code against ADR 0038
  rather than by a test.
- **A token issued by consent was not recorded in the ledger.** ADR 0038 says a
  consent creates an agent and issues a credential, and that both are ordinary
  events; the code recorded only the first. Found by connecting a real
  connector and reading the feed afterwards. The token a refresh produces stays
  out, which is what rule 4 says about authentications.
- **Signing in dropped the query string of the page you were sent to.** Only
  the path was kept, and an authorization request is a page whose query *is*
  the request, so somebody not signed in came back to a consent screen with
  nothing to consent to.

### Verified

Connected from the Claude.ai connector against a live installation over a public
address: discovery, dynamic registration, PKCE, the consent screen, the code
exchange, a tool call, a reconnection and a disconnection. Everything under
"Fixed" above was found that way or by reading ADR 0038 against the code, and
none of it by a test — the tests agreed with the code, which is what tests
written from the code do.

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
