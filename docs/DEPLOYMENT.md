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
docker volume create knoverge-postgres
docker volume create knoverge-data
docker compose up -d
```

The two volumes are created by hand, once, and declared `external` in
`docker-compose.yml`. Compose only ever removes volumes it created itself, so
this is what keeps `docker compose down -v` from taking the database and the
workspace repositories with it. Starting without them fails immediately and
says which one is missing.

Then:

```text
Web UI:     http://localhost:3000/
HTTP API:   http://localhost:3000/v1
MCP:        http://localhost:3000/mcp (Milestone 4)
Health:     http://localhost:3000/health/ready
```

One port. Exact port may change during implementation, but the final project must document it consistently.

## 4. Persistent volumes

Required persistent data:

- PostgreSQL;
- `KNOVERGE_DATA_DIR` (workspace Git repositories and attachments). Required by the `knoverge` command line as well as the server, and it must name the same directory: pointed elsewhere, the command line would create a second, empty repository for the workspace, and the integrity guard would then refuse to write to it.

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
KNOVERGE_TRUST_PROXY
KNOVERGE_LOG_LEVEL
NODE_ENV                      development | test | production

Not read yet. The features they configure do not exist, and the configuration
schema ignores unknown variables, so setting one of these today has no effect
at all — not even a warning:

KNOVERGE_LLM_PROVIDER         (Milestone 6) disabled | openai_compatible | anthropic | ollama
KNOVERGE_LLM_BASE_URL         (Milestone 6)
KNOVERGE_LLM_API_KEY          (Milestone 6)
KNOVERGE_LLM_MODEL            (Milestone 6)
KNOVERGE_EMBEDDING_PROVIDER   (Milestone 6) disabled | openai_compatible | ollama
KNOVERGE_EMBEDDING_BASE_URL   (Milestone 6)
KNOVERGE_EMBEDDING_API_KEY    (Milestone 6)
KNOVERGE_EMBEDDING_MODEL      (Milestone 6)
KNOVERGE_ATTACHMENT_MAX_MB    (Milestone 11)
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

Workspaces themselves can be listed and created with `knoverge workspace list` and `knoverge workspace create`.

### Maintenance

Two tables hold rows that stop being useful: idempotency records, which are no longer honoured after a day and hold a whole stored response, and session rows, which stop working at their expiry or when revoked. A container running the worker role removes both once an hour.

An installation that runs no worker, or an operator who wants it now, can run it directly:

```bash
docker compose exec knoverge knoverge db prune
```

Session rows outlive the session by thirty days, so the settings page can still show a person where they were recently signed in.

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
first two are taken together by the `backup` service; the third is yours to keep
somewhere else.

```bash
docker volume create knoverge-backups
docker compose --profile backup up -d
```

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

So the script dumps first. The skew is not eliminated — only `knoverge backup`
(Milestone 9), which takes the workspace write lock for the duration, will do
that — but it is pushed onto the side that is detectable and repairable.

### Secrets

The `.env` secrets, stored separately from the data backups. A backup without
`KNOVERGE_LEDGER_KEY` restores a ledger nobody can verify.

## 10. Restore

Restore order:

1. stop application writes;
2. restore PostgreSQL — `pg_restore --dbname=knoverge postgres.dump`;
3. restore the data directory — `tar -xzf data.tar.gz -C "$KNOVERGE_DATA_DIR"`;
4. run `knoverge ledger verify` (and `knoverge integrity check` once it ships in Milestone 9);
5. rebuild search/embedding indexes if needed;
6. start application. Startup recovery resolves any operation the backup caught mid-flight, and reports any it cannot.

The drill itself is covered by a test: `packages/db/test/restore.test.ts` takes a
dump of a real database, restores it into another, and checks that the ledger
chain still verifies, that the taxonomy still agrees with the archived
repository, and that no unfinished operation came back to close the workspace. A
backup nobody has restored is not a backup, and a restore procedure nothing runs
is not a procedure.

## 11. Upgrades

Docker releases use versioned image tags.

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

## 12. Reverse proxy

Production examples include at least one simple HTTPS configuration.

Caddy is the documentation default because automatic TLS keeps self-hosting simple.

Do not make Caddy a required runtime dependency.

## 13. Resource target

MVP should be comfortable on a modest single-server installation.

Target baseline:

```text
2 CPU
4 GB RAM
20+ GB disk
```

Actual capacity depends mostly on knowledge volume and local model usage.

Local LLM inference is outside the core application's resource requirement.
