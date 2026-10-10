# Self-Hosted Deployment

## 1. Deployment goals

Knoverge must support:

1. local development;
2. always-on deployment on a small VPS;
3. private home/server deployment;
4. larger server installation.

The default open-source distribution is Docker Compose.

## 2. Components

```text
knoverge     one container: HTTP API, MCP, web UI, background worker
postgres     PostgreSQL with pgvector
```

Nothing else is required. See ADR 0005.

For larger installations the same image can run a second container with `KNOVERGE_ROLE=worker`.

## 3. Local installation target

Expected workflow:

```bash
git clone <repository>
cd knoverge
cp .env.example .env
# Fill in the four values the copy leaves empty: KNOVERGE_POSTGRES_PASSWORD and
# the three secrets from section 6, each `openssl rand -hex 32`.
docker volume create knoverge-postgres
docker volume create knoverge-data
docker compose up -d
```

Nothing generates the four for you, and nothing comes up without them: compose
stops before starting anything and names the one it is missing. That is the point
— an installation that started with a password somebody else could guess would be
worse than one that did not start.

The two volumes are created by hand, once, and declared `external` in
`docker-compose.yml`. Compose only ever removes volumes it created itself, so
this is what keeps `docker compose down -v` from taking the database and the
workspace repositories with it. Starting without them fails immediately and
says which one is missing.

Then:

```text
Web UI:     http://localhost:3000/
HTTP API:   http://localhost:3000/v1
MCP:        http://localhost:3000/mcp
Health:     http://localhost:3000/health/ready
```

One port. Exact port may change during implementation, but the final project must document it consistently.

## 4. Persistent volumes

Required persistent data:

- PostgreSQL;
- `KNOVERGE_DATA_DIR` (workspace Git repositories under `repositories/<workspace id>` and uploaded files under `attachments/<workspace id>`; the backup copies the whole directory, so files are inside the backup boundary without anything else being configured). Required by the `knoverge` command line as well as the server, and it must name the same directory: pointed elsewhere, the command line would create a second, empty repository for the workspace, and the integrity guard would then refuse to write to it.

Logical volumes:

```text
knoverge-postgres
knoverge-data
```

Do not store authoritative data only inside ephemeral containers.

## 5. Remote server deployment

Recommended architecture:

```text
Internet
   ↓
HTTPS reverse proxy
   ↓
knoverge container
   ↓
PostgreSQL + data volume
```

MCP must be reachable 24/7 at a stable HTTPS URL.

Example conceptual endpoint:

```text
https://knoverge.example.com/mcp
```

## 6. Environment configuration

All variables use the `KNOVERGE_` prefix.

```text
KNOVERGE_BASE_URL             public URL; cookies are Secure when https
KNOVERGE_PORT
KNOVERGE_HOST                 127.0.0.1 by default; containers set 0.0.0.0
KNOVERGE_ROLE                 all | web | worker
KNOVERGE_DATABASE_URL
KNOVERGE_DATA_DIR
KNOVERGE_WEB_DIST             built web bundle directory; set in the image, unset in development
KNOVERGE_AUTO_MIGRATE         true (default) applies pending migrations on start
KNOVERGE_SESSION_SECRET       signs browser cookies; required; hex, at least 32 bytes
KNOVERGE_TOKEN_PEPPER         peppers agent credential hashes; required; hex, at least 32 bytes
KNOVERGE_LEDGER_KEY           HMAC key for the event ledger; required; hex, at least 32 bytes; never stored in the database
KNOVERGE_LEDGER_KEY_RETIRED   keys that verify and no longer sign, comma separated; see "Rotating the ledger key"
KNOVERGE_ENCRYPTION_KEY       encrypts webhook signing secrets; exactly 32 bytes; without it a webhook cannot be created
KNOVERGE_TRUST_PROXY
KNOVERGE_LOG_LEVEL
KNOVERGE_AGENT_READS_PER_MINUTE        600 by default, per credential
KNOVERGE_AGENT_WRITES_PER_MINUTE       60 by default, per credential
KNOVERGE_AGENT_SYNC_BATCHES_PER_MINUTE 12 by default; sync_submit_inventory carries a whole inventory
KNOVERGE_AGENT_CONCURRENCY             8 by default; requests one credential may have in flight
KNOVERGE_AGENT_PENDING_PROPOSALS       200 by default; proposals one actor may leave waiting for review
KNOVERGE_ATTACHMENT_MAX_MB             25 by default; the largest file an upload may carry
NODE_ENV                      development | test | production

Not read yet. The features they configure do not exist, and the configuration
schema ignores unknown variables, so setting one of these today has no effect
at all — not even a warning:

KNOVERGE_LLM_PROVIDER         (Milestone 8) disabled | openai_compatible | anthropic | ollama
KNOVERGE_LLM_BASE_URL         (Milestone 8)
KNOVERGE_LLM_API_KEY          (Milestone 8)
KNOVERGE_LLM_MODEL            (Milestone 8)
```

The server must start with LLM and embedding providers disabled, and today it always does: nothing reads those variables yet, and the core never will (rule 9).

The three secrets (`KNOVERGE_SESSION_SECRET`, `KNOVERGE_TOKEN_PEPPER`, `KNOVERGE_LEDGER_KEY`) must be generated once, kept out of the database, and backed up separately. Generate each with `openssl rand -hex 32`. Nothing generates them for you: the server refuses to start without them, on purpose, so that an installation cannot come up with a secret somebody else can guess.

Losing the ledger key makes historical ledger verification impossible; the knowledge itself is unaffected.

## 7. Initial bootstrap

First start should support creation of:

- first admin user;
- first workspace.

Open the web UI: while no user exists it shows the one-time setup form, which disables itself once the first administrator is created. Or use the CLI:

```bash
docker compose exec -e KNOVERGE_BOOTSTRAP_PASSWORD='...' knoverge \
  knoverge bootstrap --email you@example.com --name "Your Name" \
  --workspace-slug personal --workspace-name "Personal Knowledge"
```

Do not ship a default administrator password.

## 7a. Adding people

Self-hosted installations have no mail server by default, so there are no invitation emails. An administrator adds a member in the web UI under Workspace, either by the email of an existing account or by creating one with an initial password passed on out of band. The person changes it under Settings after signing in.

A workspace always keeps at least one owner: the last one cannot be demoted or removed.

## 7b. When somebody cannot get in

There is no mail server, so there is no reset link. ADR 0014 records the three
routes that replace one.

**A member forgot their password.** An administrator sets a new one under
Workspace and passes it on out of band. The member's sessions all end, so
anybody signed in as them is signed out. An administrator can only do this to
somebody whose role does not include a permission they lack, so an admin cannot
reset an owner's password — that would be a promotion no role change records.

**An owner forgot their password, or there is only one of them.** The operator
resets it from the command line:

```bash
docker compose exec -e KNOVERGE_NEW_PASSWORD='...' knoverge \
  knoverge user password-reset --email owner@example.com
```

**The address is wrong.** Somebody signed in changes their own under Settings,
with their password. The operator can change anyone's:

```bash
docker compose exec knoverge knoverge user email \
  --email old@example.com --to new@example.com
```

Nothing is sent to confirm a new address, because there is nothing to send it
with. An address typed wrongly is recoverable through an administrator or the
command line, and the settings page says so before saving.

## 8. Creating an agent connection

Admin UI:

```text
Agents
→ Add agent
→ Name
→ Trust tier
→ Scope
→ Create token
```

Token is displayed once.

Or from the command line:

```bash
docker compose exec knoverge knoverge agent create --name "Claude Code - Mac mini" --client-type claude-code
docker compose exec knoverge knoverge agent token issue --agent ag_...
docker compose exec knoverge knoverge agent list
docker compose exec knoverge knoverge agent token revoke --credential cred_...
```

The category tree can also be managed from the command line:

```bash
docker compose exec knoverge knoverge taxonomy create --name Projects
docker compose exec knoverge knoverge taxonomy create --name "Pixel Brisbane" --parent projects
docker compose exec knoverge knoverge taxonomy list
```

Workspaces themselves can be listed and created with `knoverge workspace list` and `knoverge workspace create`. Give the latter `--owner <email>` naming an account that already exists: without an owner the workspace has no members, and the interface lists the workspaces you belong to, so nobody can open it. The command says so when the option is left out.

### Connecting ChatGPT or Claude.ai

Those connectors cannot be handed a pasted token, so they connect through
OAuth instead, and the only thing an operator does is make the server
reachable: a connector needs a **public HTTPS address**, will not talk to
`http://localhost`, and issues tokens for whatever `KNOVERGE_BASE_URL` says
this installation is. Set it to the address people actually use, behind the
reverse proxy of section 13, or the addresses in the metadata documents will
name a host the connector cannot reach.

There is nothing to register. A person adds the connector in ChatGPT or
Claude.ai with the URL of this installation's `/mcp`, and the connector finds
the rest for itself: it is told where the authorization server is, registers
itself, and sends the person here to be asked.

What the person sees is a consent screen naming the connector and — beside it —
the host the token would go to. Saying yes creates an agent in the workspace
they pick, which needs `agent.manage` there, and that agent appears on the
Agents screen like any other: it can read, search and propose, and it writes
nothing without review until somebody says otherwise.

Connections are listed and ended in the same place. Ending one revokes every
token it issued, at once.

Ending it **there** is what ends it. Disconnecting inside ChatGPT or Claude.ai
makes that product forget its tokens; it does not tell this server anything, so
the connection stays live here. Reconnecting afterwards is recognised as the
same connector — the connection it had is retired and it keeps the agent it
already was, which the consent screen says before you press anything — but a
connector you meant to be rid of is only gone once it is gone from here.

### Maintenance

Three tables hold rows that stop being useful: idempotency records, which are no longer honoured after a day and hold a whole stored response; session rows, which stop working at their expiry or when revoked; and operation rows, which stop being interesting once decided. A container running the worker role removes all three once an hour, and in the same pass empties the proposed text of proposals resolved more than 90 days ago, keeping the rows themselves so the review trail survives. The same pass clears away OAuth registrations nobody consented to after a day, and codes and refresh tokens past their expiry.

An installation that runs no worker, or an operator who wants it now, can run it directly:

```bash
docker compose exec knoverge knoverge db prune
```

Session rows outlive the session by thirty days, so the settings page can still show a person where they were recently signed in.

### Embeddings

Disabled by default, and the default is a complete installation: search is
lexical, `workspace_manifest` reports `semantic_search: false`, and nothing
contacts anything.

**Configure this in the product, at Settings → AI and models.** The wizard asks
an address whether it answers, shows which models it holds, runs one embedding
to show how many numbers come back, and turns it on — with no restart, because
a wizard that needs one is not a wizard (ADR 0021).

The variables below still exist and do one thing: provision a **first** start.
If no provider has ever been configured and these are set, a provider is created
from them and marked as having come from the environment. After that they are
not read again, so changing them and restarting does nothing — the settings page
is where a configured installation is changed, and it says which of the two
configured each provider.

```text
KNOVERGE_EMBEDDING_PROVIDER   disabled | openai_compatible | ollama
KNOVERGE_EMBEDDING_BASE_URL   required unless disabled
KNOVERGE_EMBEDDING_MODEL      required unless disabled
KNOVERGE_EMBEDDING_API_KEY    optional; sent as a bearer token
```

`openai_compatible` posts to `<base>/v1/embeddings`, which most gateways and
local servers imitate; `ollama` posts to `<base>/api/embed`. A provider named
without a base URL and a model is refused at startup rather than run
half-configured, because an installation that silently embedded nothing would
report `semantic_search: false` and give an operator nothing to look at.

An API key is set in the interface, in the wizard, for the one kind of provider
that has any use for one. It is sealed with `KNOVERGE_ENCRYPTION_KEY` exactly as a
webhook's signing secret is, and never shown again: the page says whether a
provider has one, never which (ADR 0033). Most servers an operator runs
themselves — Ollama, a local Whisper build, llama.cpp — need none.

Without a `KNOVERGE_ENCRYPTION_KEY` there is nowhere safe to put a key, so the
field is not offered and the server refuses one rather than storing it in clear.
The screen says which variable to set.

`KNOVERGE_EMBEDDING_API_KEY` still works and is second: what the provider itself
holds wins, and the variable reaches the provider whose address matches
`KNOVERGE_EMBEDDING_BASE_URL`, so an installation configured before the field
existed keeps working without anybody re-entering anything.

The dimension is not configured — it is read from the model's own first answer.
Changing model is safe: the new one fills a profile of its own while the old
one keeps answering queries, and they change places when the last chunk is
embedded. Nothing has to be re-indexed by hand.

Vectors are computed by the worker, not on the request path, because the
provider is somebody else's server. A sweep every five minutes asks each
workspace what it is missing, and a pass that leaves anything comes straight
back for the next batch. New knowledge is findable lexically at once and
semantically within a few minutes.

### Agent budgets

One credential may make 600 reads and 60 writes a minute, 12 batches of inventory
a minute, and hold 8 requests in flight. A write takes the workspace lock, makes a
Git commit and appends to the ledger, which is why it is smaller than a read; a
batch of inventory carries a whole inventory in one call and classifies every line
of it against the workspace, which is why it is smaller again.

Beside those is a budget that is not a rate: one actor may have **200 proposals
waiting for review** at once. A rate cannot express this — sixty writes a minute
for an hour is three thousand pending proposals, all of them within budget — and
the review queue is where every agent write is decided. Reaching it answers
`RATE_LIMITED`, and what clears it is a reviewer rather than time. A write a policy
rule lets through is not counted: it is decided and gone.

Sixty writes a minute is right for an agent recording what it learns and wrong for
one loading a workspace from somewhere else, so all of them are configurable. Raise
them for the duration of an import and put them back:

```bash
KNOVERGE_AGENT_WRITES_PER_MINUTE=600
KNOVERGE_AGENT_SYNC_BATCHES_PER_MINUTE=60
KNOVERGE_AGENT_PENDING_PROPOSALS=2000
```

Whatever they are set to, `workspace_manifest` reports them under `limits`, so a
well-behaved client paces itself instead of discovering the budget by being
refused. Exceeding one is still answered `RATE_LIMITED`, which is retryable.

### A workspace that refuses to be written to

A write spans Git and PostgreSQL and cannot be one transaction, so it is done in a fixed order under a workspace lock. A process that stops in the middle leaves an unfinished operation behind, and while one is there the workspace refuses every write: the repository holds a change the database does not, and writing on top of it would re-render the file from the database and silently delete the committed change.

The server resolves these at startup. When one appears while it is running — the API answers `INTERNAL_ERROR` with `an earlier change to this workspace did not finish` and names the operation — an operator can resolve it without a restart:

```bash
docker compose exec knoverge knoverge db recover
docker compose exec knoverge knoverge db recover --workspace personal
```

It takes the same workspace lock the server's writers take, so it is safe against a live installation: it waits for whatever is writing. Each workspace is reported as examined, recovered, abandoned and unresolved. An operation that reached Git is completed from the commit; one that never committed is abandoned. Anything left **unresolved** is the case the architecture calls unrepairable — a revision with no commit, or a commit the repository no longer has — and the command names each one with the reason and exits non-zero, so a script notices. Those need the backup.

An unresolved operation closes its own workspace and nothing else: the recovery pass carries on to the rest, the server finishes starting, and the job runner runs. The reason is also written to the operation row, so `db recover` and the startup log are not the only places to find it.

### Handing the audit trail to somebody else

```bash
docker compose exec knoverge knoverge audit export --workspace personal --out /backups/audit.jsonl
docker compose exec knoverge knoverge audit verify --from /backups/audit.jsonl
```

JSON lines: a header, then one event per line. The header says which workspace, which
sequences, how many events, and a **fingerprint** of each key that could verify them —
never a key. Every event carries exactly the fields the hash covers, under the names
the hasher uses, plus the two chain hashes: category **ids** rather than paths,
because a path is a name that can change and an id cannot.

`audit verify` recomputes the whole chain from the file and the key, with no database
involved. That is the point of the format: an auditor can check that nobody edited the
trail without the installation that produced it and without trusting whoever handed it
over. It exits non-zero and says where the chain stopped holding.

`--after <sequence>` exports what follows a sequence, for an incremental run. A slice
is verified from its first line onwards — the links inside it still have to hold, and
the header says where it began.

### Rotating the ledger key

```bash
docker compose exec knoverge knoverge ledger keys
openssl rand -hex 32
# .env: move the old KNOVERGE_LEDGER_KEY into KNOVERGE_LEDGER_KEY_RETIRED,
#       put the new value in KNOVERGE_LEDGER_KEY
docker compose up -d knoverge
docker compose exec knoverge knoverge ledger verify
```

A key is retired rather than replaced: the events it signed are still there and
still verify, because rehashing them is the one thing rotation must not mean here
(ADR 0030). `verify` says `used a retired key` when a green result depended on one,
which is what tells an operator whether dropping it would cost them the proof that
nobody edited those events. `ledger keys` prints a fingerprint of each key in force
rather than the key, so checking which one is running does not put it on a terminal.

Retired keys accumulate only if you let them. Each one costs one extra HMAC at the
rotation boundary and nothing anywhere else, so there is no performance reason to
drop one — only the decision about whether that stretch of history still needs to be
verifiable.

### Pushing a notification somewhere

**Settings → Webhooks** is where one is added: the address, which event types it is
told about, whether it is delivering, and the signing secret, which is shown once.
The same screen is where an endpoint that stopped working says so — the consecutive
failures, when the next attempt is due and what went wrong last.

The request below does the same thing, for an installation configured by a script:

```bash
openssl rand -hex 32   # KNOVERGE_ENCRYPTION_KEY, if the installation has none yet
docker compose exec knoverge curl -sS localhost:3000/v1/admin/webhooks.upsert \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"url":"https://example.internal/knoverge","event_types":["knowledge.created"]}'
```

The answer carries the signing secret once. It is encrypted at rest with
`KNOVERGE_ENCRYPTION_KEY` and never served again; an operator who lost it upserts a
new one. Without that key the call is refused rather than storing a secret in clear.

What arrives is a batch of event summaries and never the knowledge (ADR 0029): a URL
is not an actor and holds no read scope, so a receiver that wants an item fetches it
with a credential of its own. Verify `X-Knoverge-Signature` as HMAC-SHA256 over
`<X-Knoverge-Timestamp>.<body>`, comparing digests rather than strings, and reject a
timestamp far from now.

Delivery is a sweep every minute, from the worker role. Each endpoint carries a
cursor over the workspace's ledger sequence, so a delivery that fails resends rather
than skips — at least once, in order, keyed on an event id that does not change. A
failing endpoint is retried further and further apart, up to half an hour, and
`webhooks.list` shows the consecutive failures and the last error. A new webhook
starts from the current sequence: adding one asks for what happens next, not for a
replay of the workspace's history.

`event_types` empty means every type, including a type a later version adds, which is
what the screen's "everything that happens" sends. Redirects are refused, and private
addresses are not blocked — see `SECURITY.md`.

### Whether the two stores still agree

```bash
docker compose exec knoverge knoverge integrity check
docker compose exec knoverge knoverge integrity check --workspace personal --json
```

PostgreSQL holds an index of the knowledge and Git holds the knowledge itself, so
the two can disagree and only one of them is canonical. Every write goes through
the cross-store writer so that they cannot disagree by accident, and recovery
repairs the one case a crash produces. This is the check that neither of those is
quietly failing, and it is the command to run after a restore.

Per workspace it reports the items examined, the events the chain was recomputed
over, and every finding:

| finding | what it means |
| --- | --- |
| `operation_unfinished` | a write stopped half way; `knoverge db recover` resolves it |
| `ledger_broken` | the hash chain does not hold together from some sequence on |
| `commit_missing` | a revision names a commit the repository does not have |
| `file_missing` | the file a revision recorded is not there |
| `content_hash_mismatch` | the file does not hash to what the database recorded |
| `frontmatter_disagrees` | the file's metadata and the revision's disagree, field by field |
| `taxonomy_missing` / `taxonomy_disagrees` | `taxonomy.yaml` is absent or is not the tree the database holds |
| `head_unknown` | the branch is at a commit no revision and no taxonomy version was written by — somebody committed by hand; `knoverge adopt-commits` records it |

It exits non-zero when it finds anything, so a scheduled run is a check rather than
a log line. The findings name objects and field names and never any knowledge: a
report is not a place for the text it is reporting about.

It reads and never writes. An integrity checker that repaired things would be the
fourth way knowledge changes in this product and the least reviewed one — the
repairs live in `db recover` and, where nothing can repair, in the backup.

### Permission grants from the command line

`knoverge permissions list`, `grant` and `revoke` administer grants as the workspace system actor. They exist because a grant can restrict the people who administer grants, and a restriction is deliberately not lifted by the person it restricts:

```bash
docker compose exec knoverge knoverge permissions list
docker compose exec knoverge knoverge permissions revoke --grant grant_01J...
docker compose exec knoverge knoverge permissions grant --actor act_01J... \
  --action taxonomy.manage --effect deny --category cat_01J...
```

### Reading command line output from a script

Every listing writes tab-separated rows to standard output and nothing else. Headers, counts and failure detail go to standard error, so `knoverge taxonomy list > categories.tsv` gives you rows and only rows. `--tree` indents names to show the hierarchy, which is for reading, not for parsing.

`--json` prints the whole result as one object, using the same field names as the HTTP API. `ledger verify` exits 1 when any workspace is broken, and `db status` exits 1 when migrations are pending, so both can gate a deployment step.

Commands ask only for the secrets they use. `workspace list` needs the database URL alone; `ledger verify` needs the ledger key as well; issuing a credential needs the token pepper.

### Rotating an agent credential

Rotation is issue then revoke, in that order, so the agent is never without a working token:

```bash
docker compose exec knoverge knoverge agent token issue --agent ag_01J...
docker compose exec knoverge knoverge agent token list --agent ag_01J...
docker compose exec knoverge knoverge agent token revoke --credential cred_01J...
```

Both steps are recorded in the ledger. There is no single rotate operation: one would have to decide for you when the old token stops working, and an agent holding a token that was revoked before it was given the new one is worse than two live tokens for a minute.

The same two steps are in the browser, on an agent's **Credentials** tab, with the fact that says the second one is safe: a live token with a newer one beside it reads *"not used since NEWPREFIX was issued"* when the agent has moved on, and *"still being used"* with how long ago when something is still presenting it. Revoking asks first and repeats which of the two it is, because finishing a rotation and taking a client offline are the same click otherwise.

Tokens look like `knv_<prefix>_<secret>`. Only a peppered hash is stored, so a lost token cannot be recovered; issue a new one and revoke the old. Disabling an agent revokes all of its credentials.

Connection examples for common MCP clients (Claude Code, Cursor, generic Streamable HTTP client, stdio bridge) are provided after implementation:

```bash
# local stdio bridge for clients without remote MCP support
KNOVERGE_URL=https://knoverge.example.com KNOVERGE_TOKEN=knv_... knoverge mcp stdio
```

## 8a. What does and does not destroy data

The database lives in the `knoverge-postgres` volume and the workspace Git
repositories in `knoverge-data`. Both survive everything that happens to the
containers:

- a container crash — `restart: unless-stopped` brings it back;
- `docker compose stop`, `docker compose restart`, `docker compose down`;
- rebuilding the image, `docker compose up -d --build`;
- rebooting the host.

Three commands destroy them, and nothing else does:

```bash
docker compose down -v            # refused: the volumes are external
docker volume rm knoverge-data    # this is the one that means it
docker system prune --volumes     # takes every unused volume on the machine
```

The first is listed because it is the one people reach for. With external
volumes it removes the network and the containers and leaves the data alone.
`docker system prune --volumes` is still dangerous: it does not care who
created a volume, only that nothing is using it, so never run it while the
stack is down.

An installation that predates external volumes has its data in
`knoverge_knoverge-postgres` and `knoverge_knoverge-data` — Compose prefixed
them with the project name. Point the new declarations at the old volumes
instead of copying anything:

```bash
KNOVERGE_POSTGRES_VOLUME=knoverge_knoverge-postgres
KNOVERGE_DATA_VOLUME=knoverge_knoverge-data
```

## 9. Backups

A complete backup contains the database, the data directory and the secrets. The
first two are taken together, on a schedule by the `backup` service or on demand by
`knoverge backup`; the third is yours to keep somewhere else.

```bash
docker volume create knoverge-backups
docker compose --profile backup up -d
```

### On demand, with nothing writing

```bash
docker compose exec knoverge knoverge backup --out /backups --keep-days 14
```

Same layout, one difference, and it is the one that matters: this takes the write
lock of every workspace and holds it for the whole run, so no canonical write can
start while the dump and the archive are taken. The scheduled service cannot do
that — it is a separate container with read-only access to the data and no way to
reach the locks — so its backups carry the skew described below. This one does not.

A workspace that is being written when the command starts makes it wait, and the
server bounds that wait; a command that cannot get the locks fails rather than
taking a skewed backup. The manifest records where each workspace's ledger stood
under the lock:

```text
taken_at=20260927T112951Z
taken_by=knoverge backup
order=postgres-then-data
locked=every-workspace
data_dir=/data
workspace=ws_01M348EV806RS0Y5XFXCZFFATD slug=knoverge sequence=199
```

so a restore can check it came back to the sequence it was taken at.

It is a profile rather than a default service because a complete installation is
one application container plus PostgreSQL, and an operator with their own backup
arrangement should not be handed a second one. Each run writes a directory named
for its UTC timestamp:

```text
/backups/20260920T110514Z/postgres.dump   pg_dump --format=custom
/backups/20260920T110514Z/data.tar.gz     the workspace repositories
/backups/20260920T110514Z/manifest.txt    what was taken, and in what order
```

`KNOVERGE_BACKUP_INTERVAL` (default 86400) and `KNOVERGE_BACKUP_KEEP` (default
14) set the schedule and the retention window. A run that dies half way leaves a
`.partial` directory that rotation ignores and a restore cannot mistake for a
whole backup.

### Why the database is dumped before the data directory

A canonical write commits to Git and then to PostgreSQL (section 4 of
`ARCHITECTURE.md`). A backup taken while one is in flight is therefore skewed,
and the order decides which way:

- **database first, then the repositories** — the archive may hold a commit the
  dump does not know about. That is an unfinished operation, which recovery
  detects at startup: the workspace refuses writes and says which operation is
  unresolved.
- **repositories first, then the database** — the dump may hold a revision row
  whose commit is not in the archive. The architecture calls that corruption,
  and nothing can repair it, because the knowledge itself is the part that is
  missing.

So the script dumps first. The skew is not eliminated — `knoverge backup` is what
eliminates it, by holding every workspace write lock for the duration — but it is
pushed onto the side that is detectable and repairable.

### Secrets

The `.env` secrets, stored separately from the data backups. A backup without
`KNOVERGE_LEDGER_KEY` restores a ledger nobody can verify.

## 10. Restore

```bash
docker compose stop knoverge
docker compose run --rm --entrypoint knoverge knoverge restore --from /backups/20260927T112951Z
docker compose start knoverge
```

`knoverge restore` does the two mechanical steps and the two that matter either
side of them. Before: it reads the manifest, refuses a directory that is not a
whole backup, refuses while anything else is connected to the database — "stop
application writes" is step one and the command checks it rather than trusting it
— and refuses a database that already holds knowledge unless `--force` says to
replace it, naming the workspaces it would replace. After: it verifies the ledger
chain of every workspace and compares each head with the sequence the manifest
recorded, and exits non-zero if any of them did not come back where the backup
left it. Follow it with `knoverge integrity check`, which is the one that reads the
repository. A script that restores and carries on regardless is how a bad restore
goes unnoticed until somebody reads knowledge that is not there.

By hand, the same order:

1. stop application writes;
2. restore PostgreSQL — `pg_restore --clean --if-exists --dbname=knoverge postgres.dump`;
3. restore the data directory — `tar -xzf data.tar.gz -C "$KNOVERGE_DATA_DIR"`;
4. run `knoverge integrity check`, which verifies the chain as part of its work;
5. rebuild search/embedding indexes if needed — `knoverge db reindex`;
6. start application. Startup recovery resolves any operation the backup caught mid-flight, and reports any it cannot.

The drill itself is covered by a test: `packages/db/test/restore.test.ts` takes a
dump of a real database, restores it into another, and checks that the ledger
chain still verifies, that the taxonomy still agrees with the archived
repository, and that no unfinished operation came back to close the workspace. A
backup nobody has restored is not a backup, and a restore procedure nothing runs
is not a procedure.

## 11. Taking a workspace somewhere else

A backup and an export answer different questions, and reaching for the wrong one
is found out late. A **backup** is this installation: a PostgreSQL dump for a
matching major version, the whole data directory, agents, credentials, permissions
and a ledger keyed with this installation's `KNOVERGE_LEDGER_KEY`. An **export** is
one workspace's knowledge and its history, in a form somebody can read with git and
nothing else.

```bash
docker compose exec knoverge knoverge export --workspace personal --out /backups --attachments
```

What it writes:

```text
/backups/20260929T100000Z-ws_01M3…/repository.bundle  the knowledge and every revision
/backups/20260929T100000Z-ws_01M3…/manifest.json      what the files cannot say
/backups/20260929T100000Z-ws_01M3…/README.md          how to open it without this product
/backups/20260929T100000Z-ws_01M3…/attachments/       with --attachments, by content hash
```

The bundle is the whole of it, and opening it needs nothing from here:

```bash
git clone repository.bundle workspace
```

Inside is what `GIT_REPOSITORY.md` describes: Markdown with YAML frontmatter, the
category tree in `taxonomy.yaml`, and every revision as a commit whose trailers say
which item and which revision it was. The manifest adds the workspace's slug, name
and default language, where the ledger stood, and the display name of each actor a
trailer names — so a reader can see who `act_01…` was without anybody's sign-in
address leaving the installation.

**Attachments are listed either way and carried with `--attachments`.** They are
not in Git and cannot be rebuilt from anything (ADR 0008), so an export without
them leaves items whose sources point at nothing — and they are the part that makes
an export gigabytes. A row whose file is not in the store is named in the output and
marked `included: false` in the manifest rather than quietly promised.

**What an export leaves out**, each on purpose: agents, credentials, permissions and
policy rules, because who may write is a statement about an installation; proposals
and sync sessions, because work in flight belongs to the installation doing it; the
event ledger, because its chain is keyed with a key that never leaves the
environment — `knoverge audit export` writes it as evidence and evidence is what it
stays; and embeddings, which the receiving installation rebuilds with whatever model
it has. ADR 0034 has the reasoning.

The workspace write lock is held for the read, so the bundle and the manifest
describe one moment: an export taken while a write was landing would name a ledger
sequence the bundle does not reach.

### Bringing one in

```bash
docker compose exec knoverge knoverge import --from /backups/20260929T100000Z-ws_01M3… --slug moved
```

It creates the workspace, clones the bundle into place, restores the taxonomy and
the attachment rows, and then walks the commits oldest first so the revisions come
back in the order they were made. `--slug` is for when the name it came from is
already taken here.

What arrives is the knowledge, its history, its provenance and its taxonomy. What
does not is everything about the other installation: no agents, no credentials, no
permissions, no policy rules, no proposals. **Grant your people and agents access
before anybody can use it** — the command says so when it finishes, and that step
is where this installation states its own rules.

The people the commits name are recreated as actors with their display names and
nothing behind them, so the interface still says who wrote what and none of them
can sign in or write again.

Two things it refuses, and both are the same refusal in different words. A
workspace that already holds knowledge: merging two that may share item ids is a
reconciliation, not an import. And an installation that already holds these items:
item ids survive an export, so this is a move rather than a way to make a second
copy beside the first — the command names the ids that are taken.

### A folder of notes

An export is this product's own file and its items cannot collide with anything
here. A folder of somebody's notes is the opposite case: half of it is probably a
restatement of what the workspace already holds. So it arrives the way an agent
arrives — a session, an inventory, and an answer about each candidate (ADR 0036).

```bash
docker compose exec knoverge knoverge import-folder \
  --from /import/vault --agent ag_01M3… --workspace personal
```

```text
session sync_01M3…
412 files read, 412 offered
exact_known     180
likely_match     44
new_candidate   188
nothing has been written; read the session and decide what to propose
```

**Nothing is written.** The inventory carries a title, a type and two
fingerprints — the file as it was read, and the normalised title and body — never
the text. What the workspace makes of each candidate appears on the Sync screen,
and turning that into proposals is the next decision somebody makes.

The agent is named on the command line and decides everything else: its policy
says whether what follows needs review (rule 5, rule 14), and its trust tier is
already configured. An operator who wants a folder to land directly grants that
agent `allow_direct` and knows they did.

The path inside the folder is the key, so a folder pointed at twice is classified
twice and inserted once. `--source-system` and `--namespace` name the tool and the
folder, so two vaults imported into one workspace do not look like one vault that
changed its mind.

### Turning what it found into proposals

```bash
docker compose exec knoverge knoverge propose-from-session \
  --session sync_01M3… --from /import/vault --workspace personal
```

```text
188 waiting for review
180 left alone: exact_known
44 left alone: likely_match
```

Two commands with a person in between, because an inventory is a question and
proposing is what somebody decides after reading the answer. Only `new_candidate`
is acted on: `likely_match` means "read those items and decide", and deciding is
not a thing to do in a loop.

Each file is read again and checked against the fingerprint the session recorded.
One that changed since is left alone with that as the reason — proposing text the
workspace never classified would make the session a record of something that did
not happen.

A candidate suggesting a category the taxonomy does not have is proposed without
it. The folder structure is a suggestion, and creating categories is a separate
decision with its own review.

What happens to a proposal is the agent's policy, not this command's: by default
an agent's writing waits for review (rule 14), and an agent with `allow_direct`
writes straight through. The output says which of the two happened.

**Tags come across.** Both ways a person writes them: `tags:` in the frontmatter,
as a list or on one line, and `#tag` in the text, which is what Obsidian and most
editors do. A tag written both ways is one tag. A `#` at the start of a line is a
heading and a `#` inside a word is part of the word — neither is a tag.

That is also what an Obsidian vault is: the same command, because a vault is a
folder of Markdown with tags in it and `.obsidian/` skipped like every other
dot-directory.

### When somebody edits the repository directly

Rule 1 says the knowledge is Markdown in a Git repository, readable and editable
without this product. People take that literally: clone the workspace repository,
fix a typo in forty files, commit. Until `adopt-commits` existed the answer to
that was a finding — `integrity check` said `head_unknown` and stopped — and the
only ways out were to revert the commit or to redo the work through the product.

```bash
docker compose exec knoverge knoverge adopt-commits --workspace personal
```

It walks the commits the database has never heard of, oldest first, and writes the
revisions they describe. An external commit carries no trailers, so **the file is
what says which item it is**, through the id in its frontmatter: an id this
workspace holds is an update, a new one is a create, and a file with no id or one
that will not parse is named and skipped — inventing an id would be inventing the
thing the file was supposed to say.

Every commit in the history is considered, not everything after the newest one the
database knows: a commit made by hand can sit between two the product made, and a
range would skip it for ever.

The revision id is new, because nothing in an external commit proposes one. The
write is the system actor's, and the events say `adopted` and carry the commit —
the person who made the change is the Git author, one lookup away.

It refuses a repository whose history was rewritten. If the newest commit this
workspace was written from is no longer in the branch, this is not the history
these records describe, and that is `integrity check`'s unrepairable case.

A commit that changed a file without changing the knowledge — trailing whitespace,
a line ending — produces no revision. A revision that says nothing happened is
worse than no revision.

### Anything else, as JSON

```bash
docker compose exec knoverge knoverge import-json \
  --file /import/notion.json --agent ag_01M3… --workspace personal
```

The path for the exports nobody wrote a parser for: a Notion export, a wiki dump,
somebody's script. The same three steps as a folder, because the shape is the
shape — a session, an inventory, an answer per candidate.

Forgiving about what fields are called and strict about what a record has to be.
`body`, `text`, `content` and `markdown` are the four names the same field goes
by; `title`, `name` and `heading` likewise; `id`, `key`, `uuid` and `slug` are the
identity. A record with no title or no body is not knowledge in any shape, and the
output says how many there were, because that number is what tells somebody their
export had a shape this did not understand.

The file is an array, or an object with one array in it. An object with two is
refused: choosing one of them would be choosing what to import, and getting that
wrong quietly is worse than saying nothing was found.

**A record with no id of its own is keyed by its position**, which is stable only
while the file is. The output says how many, every time, because a second run on a
changed export would not recognise them.

### The links between the notes

```bash
docker compose exec knoverge knoverge link-from-folder \
  --from /import/vault --agent ag_01M3… --workspace personal
```

Run **after** the proposals a folder produced have been accepted, because a
relation needs both ends to exist as items: when a note is proposed, the note it
links to may still be in the queue.

`[[Target]]`, `[[Target|shown as this]]` and `[[Target#a heading]]` are one link to
`Target` — the display text and the heading are about how the link reads, not
about what it points at. A link inside a code fence is left alone, because a note
about wiki syntax is not a note that links to anything.

Every link becomes `relates_to`. A wiki link says two notes are connected and
nothing more precise; reading `supersedes` or `contradicts` into one would be
inventing a claim the person never made.

What cannot be resolved is named rather than dropped: a name no note has, a name
two notes share — write the path in the link to say which — and a note nobody has
accepted yet, which is not an item to attach anything to. A link a note makes to
itself is not a relation, and one whose relation is already there is not a change,
so neither produces a proposal nobody asked for.

Titles come from the frontmatter, then from an opening heading, then from the
filename. An opening heading that repeats the title is taken out of the text,
because this product's own files keep the title in the frontmatter — without that,
a note and the item made from it would never fingerprint the same and the importer
could never say "you already have this".

A file the export listed but did not carry becomes an attachment row marked
`failed`, saying so. The items that came out of it are there either way; what is
missing is the original, and `knoverge integrity check` reports it as the
unrepairable kind.

## 12. Upgrades

### Released images

```bash
docker pull ghcr.io/gynsus/knoverge:0.3.0
```

`ghcr.io/gynsus/knoverge`, built for `linux/amd64` and `linux/arm64` — a self-hosted
installation is as likely to be somebody's own small machine as a cloud instance. A
tag `vX.Y.Z` publishes `X.Y.Z`, and a release that is not a prerelease also moves
`latest`; a prerelease does not, because somebody pulling without a tag is asking for
the current release rather than the next one being tried.

The version is baked in at build time, so a release says which one it is:

```bash
docker run --rm --entrypoint knoverge ghcr.io/gynsus/knoverge:0.3.0 --version
```

`/health` and `workspace_manifest` report the same number, and the MCP handshake
carries it. The number in the repository's `package.json` is `0.0.0` and stays there:
the version of a release is the tag it was cut from, and a build that reported the
source tree's number would report the same number for every release ever made.

The compose file builds the image locally by default. To run a released one, replace
the `build` block with `image: ghcr.io/gynsus/knoverge:0.3.0`.

### Schema

Database schema uses migrations, run automatically on start unless `KNOVERGE_AUTO_MIGRATE=false`. With auto-migration disabled, run them explicitly:

```bash
docker compose exec knoverge knoverge db status
docker compose exec knoverge knoverge db migrate
```

`/health/ready` reports `degraded` while migrations are pending.

The server does not crash when PostgreSQL is unreachable at start. It listens immediately, answers `/health/live`, reports `/health/ready` as `degraded` (HTTP 503), and retries the database bootstrap (migrations, job runner) with exponential backoff up to 30 seconds between attempts until it succeeds.

When several application containers share one database (for example a `web` and a `worker` role), they may all start with auto-migration on. Migration runs hold an advisory lock, so the second container waits for the first and then finds nothing left to apply. Running `knoverge db migrate` beforehand is still the clearer choice for a scheduled upgrade, because it separates the schema change from the restart.

Upgrade path:

```text
backup
pull new image
start (migrations run)
run readiness/integrity checks
```

## 13. Reverse proxy

A complete installation is one application container plus PostgreSQL. A proxy is not
required and is not a dependency — but an installation reachable from the Internet
wants TLS in front of it, and Caddy is the documentation default because it gets and
renews the certificate by itself.

`infra/caddy/Caddyfile` is the file to start from:

```caddyfile
knoverge.example.com {
	reverse_proxy knoverge:3000 {
		flush_interval -1
		transport http {
			read_timeout 10m
		}
	}
	encode zstd gzip
}
```

It is a compose profile, like the backup service, so it is opt-in rather than part
of a complete installation:

```bash
docker compose --profile proxy up -d
```

Take the application's own port mapping away when you do, so it is reachable only
through the proxy. `caddy-data` and `caddy-config` are ordinary compose volumes
rather than external ones, unlike the knowledge base's: what is in them is a
certificate and an account key, and losing those costs a renewal.

Three things matter, whatever proxy it is.

**`KNOVERGE_TRUST_PROXY=true`, and only behind one.** The server reads
`X-Forwarded-For` only when this is set, because an anonymous caller's address is
what per-actor rate limiting falls back to: believing that header from an untrusted
hop lets anybody spend somebody else's budget. Set it when there is a proxy in
front, and never when the server is reachable directly.

**`KNOVERGE_BASE_URL` decides cookie security.** Cookies are marked `Secure` when it
is `https`, so the URL has to be the public one rather than the container's.

**The MCP endpoint is Streamable HTTP.** A POST's answer may be a stream held open
while a tool runs, so the proxy must not buffer it (`flush_interval -1`) and must not
cut it off early (a read timeout in minutes, not seconds). A buffering proxy makes an
agent wait for the whole answer before it sees any of it; a short timeout ends a long
tool call in the middle.

The application sends its own HSTS, CSP and frame headers, so the proxy adds none:
two sources for one header is how one of them ends up wrong. Compression is the
exception, because the application does not do it.

## 14. Resource target

MVP should be comfortable on a modest single-server installation.

Target baseline:

```text
2 CPU
4 GB RAM
20+ GB disk
```

Actual capacity depends mostly on knowledge volume and local model usage.

Local LLM inference is outside the core application's resource requirement.
