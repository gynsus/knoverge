# Codebase Conventions

How the packages fit together and the patterns every feature follows. `CLAUDE.md` lists package responsibilities; this document describes the mechanics.

## 1. Layering

```text
contracts   Zod schemas, enums, ids, error codes. No runtime dependencies on other packages.
core        Domain services and ports (interfaces). Depends on contracts and policy.
db          Drizzle schema, migrations, repositories implementing core ports, unit of work.
git-store   Markdown, hashing, Git operations implementing core ports.
search      Projections and retrieval implementing core ports.
auth        Password and token hashing primitives.
policy      Permission and policy evaluation, used by core services.
server      Fastify adapters (HTTP, MCP), composition root, worker.
cli         Command adapters, composition root.
web         React SPA. Talks only to the HTTP API.
```

Dependencies point downward only. `core` never imports `db`, `server` or `cli`; it declares ports and receives implementations in constructors.

## 2. Ports and repositories

A port is an interface in `core` (for example `EventRepository`, `WorkspaceRepository`). `db` exports factory functions (`createEventRepository(db)`) returning objects that implement the port. Services receive ports through an options object in their constructor.

Repositories translate between database rows and core record types. They contain no business rules and never emit events.

## 3. Transactions

`core` defines an opaque `Tx` handle and a `UnitOfWork` port:

```ts
await uow.run(async (tx) => {
  await repo.insert(tx, row);
  await ledger.append(tx, workspaceId, actor, event);
});
```

A domain change and its ledger event always share one transaction. Repositories unwrap `Tx` with `asTx()` from `db`; nothing else touches it. Read-only queries outside a transaction take no `Tx`.

When a check cannot be expressed as a unique constraint, use `uow.runExclusive(key, fn)`. It holds a named lock for the whole transaction, so a second caller waits for the first to commit and then sees its rows. First-run setup uses it.

A transaction that takes more than one lock takes them in this order: named locks from `runExclusive`, then the taxonomy version lock of a workspace, then the event ledger lock. Any other order can deadlock two transactions against each other. Deadlocks and serialisation failures are retried a few times inside the unit of work, so ordinary contention does not reach the caller as an internal error.

A pre-check outside the transaction gives a good error message; it does not make an operation safe. Anything that must not happen twice needs a unique constraint or a lock, and the repository maps the resulting violation to a domain error.

## 4. Ids and time

Ids are prefixed ULIDs from `newId(prefix)` in `core`; prefixes live in `contracts`. Ids identify, they never order: ordering uses explicit columns such as `events.sequence`.

Services take a `Clock` port (default `systemClock`) so tests control time.

## 4a. Authorization

`packages/policy` holds pure evaluation: scope matching, permission grants (deny wins) and policy rules (first match by priority, ties broken by id). It has no storage and no side effects, which keeps the rules unit-testable in isolation.

`core` wires it to storage in `AuthorizationService`: it loads the caller's stored grants, adds the baseline implied by their role or trust tier, resolves category ancestors from the materialised paths, and either returns a decision or throws `FORBIDDEN` and records a `command.denied` event. Adapters call `requirePermission` and never evaluate rules themselves.

## 4b. Retry safety

A mutation that a client might retry takes an optional idempotency key, from the `Idempotency-Key` header or the `idempotency_key` body field. `IdempotencyService.run` wraps the work: the same key with the same body replays the stored response, a different body is refused, and the record expires after a day. Anything whose response carries a secret is left out, because replaying it would mean storing the secret.

## 5. Ledger

Every material write calls `EventLedger.append` inside the same transaction, after the change. Event metadata holds ids, hashes, counts and decision codes only, never knowledge text or secrets. Values must survive a JSON round trip through `jsonb` unchanged: strings, booleans, integers below 2^53, nested objects and arrays of those. See ADR 0007 and `DATA_MODEL.md` section 22.

## 6. Errors

Services throw `DomainError(code, message, options)` for expected failures. Adapters map it to the shared `ApiError` payload and to an HTTP status (`HTTP_API.md`). Unexpected errors propagate and become `INTERNAL_ERROR` at the adapter boundary; their messages are never sent to clients.

## 7. Composition roots

`apps/server/src/index.ts` and `apps/cli/src/services.ts` construct the database, repositories, ledger and services. Nothing else instantiates infrastructure. Configuration is read once from `KNOVERGE_*` variables through a Zod schema and passed down as values.

## 8. Contracts first

For every MCP/HTTP operation: schema in `contracts`, service in `core`, then both adapters, then contract tests through both transports (`WORKFLOW.md` section 7).

## 9. Tests

- `core`: unit tests with in-memory port implementations.
- `db`: integration tests against PostgreSQL through Testcontainers (`pgvector/pgvector:pg17`), covering migrations, repositories and database-level guarantees such as triggers.
- `server`: Fastify `inject` tests against the real composition root and a PostgreSQL container, with only the readiness probes faked; contract tests through MCP and HTTP.
- `web`: Vitest with jsdom and Testing Library.

Shared fixtures live next to the tests that use them until two packages need the same one.

## 10. Migrations

Schema changes are made in `packages/db/src/schema`, then `pnpm --filter @knoverge/db migrations:generate --name <topic>`. Database-level guarantees that Drizzle does not model (triggers, functions, extensions) are appended to the generated SQL after a `--> statement-breakpoint` line and reviewed like code. Policy: `WORKFLOW.md` section 9.
