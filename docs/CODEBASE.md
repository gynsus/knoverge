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

`core` wires it to storage in `AuthorizationService`: it loads the caller's stored grants, adds the baseline implied by their role or trust tier for the actions the grants do not already cover, resolves category ancestors from the materialised paths, and either returns a decision or throws `FORBIDDEN` and records a `command.denied` event.

Adapters call `requirePermission` for an operation on one thing, and `requireListPermission` plus `authorization.filter` for an endpoint that lists things. Checking a listing against one empty target would refuse anyone whose grant covers a single branch.

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

## Choosing a workspace in the browser

A person can belong to several workspaces, and the server refuses a request
that names none of them. `apps/web/src/auth/use-workspace.ts` holds the choice,
sends it as `X-Knoverge-Workspace` on every request, and remembers it per
browser. The picker appears in the header only when there is more than one.

The same hook reports what the caller may do, which `/v1/workspace.get` returns
as `permissions`. Navigation entries and mutation controls are shown from that,
not from the membership role: the server gates on the permission, and a second
copy of the rule in the browser drifts from it. A reviewer granted an action
explicitly would otherwise be shown a control they are entitled to use, and a
viewer would be shown forms whose every submission is refused.

## The taxonomy is the first thing in the repository

Every taxonomy change rewrites `taxonomy.yaml` in the same commit, which is
what `docs/GIT_REPOSITORY.md` section 6 requires, so the four mutations are the
first cross-store writers.

The file is committed before PostgreSQL is written, so it is rendered from a
tree computed in memory by `packages/core/src/taxonomy/projection.ts`. That is
a second implementation of what the SQL statements do, and two implementations
of one rule drift, so `packages/db/test/concurrency.test.ts` applies every
mutation to a real database and compares the two.

A read inside one of these writes takes the transaction. Through the pool it
would need a connection the write is already holding, and it could not see what
the transaction has written either.

## Writing to PostgreSQL and Git together

`packages/core/src/operations` holds the primitive every canonical write goes
through: `CrossStoreWriter` runs the order `docs/ARCHITECTURE.md` section 4
fixes, and `RecoveryService` finishes or abandons a write that was interrupted.

The lock is `UnitOfWork.withWorkspaceLock`, which is session-scoped on a
connection of its own because the write spans three transactions and a Git
commit. `runExclusive` keeps its transaction-scoped meaning for single
transaction work such as first-run setup. ADR 0012 records why, including why
a process that dies leaves an operation row rather than a lock nobody can
release.

## The web interface

Styling is Tailwind CSS; components are shadcn/ui copied into
`apps/web/src/components/ui` rather than installed, so they are our code under
our licence. ADR 0013 records the decision, including why colour is expressed
as semantic tokens with no `dark:` variant, and why a table becomes a labelled
list on a phone.

Forms are `grid gap-4` and their submit button carries `justify-self-start`.
Both matter: without the gap the button sits against the last field, and
without the alignment a grid stretches it across the card.

Fields are grouped with `FieldSet`, or with `FieldGroup` when the group needs a
subheading of its own. The spacing and the heading live in those components
rather than at each call site, because a class list repeated at every form is
the thing that drifts. A `legend` takes no part in the grid's gap, which is why
`FieldGroup` gives it a margin: without one it sits against the first field's
label.

Two rules follow from it. A cell in `ui/table.tsx` must pass a `label`, because
that heading is what a narrow screen shows beside the value. And the native
`select` is used for short lists of fixed values, because it is what a phone
opens as a wheel and what a screen reader already knows.
