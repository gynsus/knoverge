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
docker compose up -d
```

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
- `KNOVERGE_DATA_DIR` (workspace Git repositories and attachments).

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
KNOVERGE_BASE_URL
KNOVERGE_PORT
KNOVERGE_ROLE                 all | web | worker
KNOVERGE_DATABASE_URL
KNOVERGE_DATA_DIR
KNOVERGE_WEB_DIST             built web bundle directory; set in the image, unset in development
KNOVERGE_AUTO_MIGRATE         true (default) applies pending migrations on start
KNOVERGE_SESSION_SECRET       (Milestone 1, sessions)
KNOVERGE_TOKEN_PEPPER         (Milestone 1, agent credentials)
KNOVERGE_LEDGER_KEY           HMAC key for the event ledger; required; hex, at least 32 bytes; never stored in the database
KNOVERGE_ENCRYPTION_KEY       encrypts webhook signing secrets and other recoverable secrets
KNOVERGE_TRUST_PROXY
KNOVERGE_LOG_LEVEL
KNOVERGE_DEFAULT_LOCALE       en | ru

KNOVERGE_LLM_PROVIDER         disabled | openai_compatible | anthropic | ollama
KNOVERGE_LLM_BASE_URL
KNOVERGE_LLM_API_KEY
KNOVERGE_LLM_MODEL

KNOVERGE_EMBEDDING_PROVIDER   disabled | openai_compatible | ollama
KNOVERGE_EMBEDDING_BASE_URL
KNOVERGE_EMBEDDING_API_KEY
KNOVERGE_EMBEDDING_MODEL

KNOVERGE_ATTACHMENT_MAX_MB    (later milestone)
```

The server must start with LLM/embedding providers disabled.

The four secrets (`SESSION_SECRET`, `TOKEN_PEPPER`, `LEDGER_KEY`, `ENCRYPTION_KEY`) must be generated once, kept out of the database, and backed up separately. `knoverge bootstrap` can generate them into `.env` when absent. Losing the ledger key makes historical ledger verification impossible; the knowledge itself is unaffected.

## 7. Initial bootstrap

First start should support creation of:

- first admin user;
- first workspace.

```bash
docker compose exec knoverge knoverge bootstrap
```

or a secure one-time web bootstrap page that disables itself after use.

Do not ship a default administrator password.

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

Connection examples for common MCP clients (Claude Code, Cursor, generic Streamable HTTP client, stdio bridge) are provided after implementation:

```bash
# local stdio bridge for clients without remote MCP support
KNOVERGE_URL=https://knoverge.example.com KNOVERGE_TOKEN=knv_... knoverge mcp stdio
```

## 9. Backups

A complete backup contains:

### PostgreSQL

Use `pg_dump` or scheduled database snapshots.

### Data directory

Archive/snapshot `KNOVERGE_DATA_DIR`.

### Secrets

The `.env` secrets, stored separately from the data backups.

Backups should share a coordinated timestamp. `knoverge backup` (Milestone 9) pauses writes briefly, dumps the database and archives the data directory in one run.

## 10. Restore

Restore order:

1. stop application writes;
2. restore PostgreSQL;
3. restore the data directory;
4. run `knoverge integrity check`;
5. rebuild search/embedding indexes if needed;
6. start application.

## 11. Upgrades

Docker releases use versioned image tags.

Database schema uses migrations, run automatically on start unless `KNOVERGE_AUTO_MIGRATE=false`. With auto-migration disabled, run them explicitly:

```bash
docker compose exec knoverge knoverge db status
docker compose exec knoverge knoverge db migrate
```

`/health/ready` reports `degraded` while migrations are pending.

The server does not crash when PostgreSQL is unreachable at start. It listens immediately, answers `/health/live`, reports `/health/ready` as `degraded` (HTTP 503), and retries the database bootstrap (migrations, job runner) with exponential backoff up to 30 seconds between attempts until it succeeds.

When several application containers share one database (for example a `web` and a `worker` role), enable auto-migration on exactly one of them or run `knoverge db migrate` before starting them; two processes applying the same migration at the same moment is not supported.

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
