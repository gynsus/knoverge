# ADR 0012: Holding a write across PostgreSQL and Git

- Status: Accepted
- Date: 2026-09-20

## Context

ARCHITECTURE.md section 4 fixes the order of a canonical write: take the workspace
write lock, record a pending operation, render the files, commit to Git, record the
commit hash, then in one PostgreSQL transaction write the revision metadata, update
the item, append the ledger event and mark the operation committed.

Milestone 1 has no cross-store write, so nothing in the code implements this. Three
pieces of the existing foundation are shaped for single-transaction work and would
be wrong if reused as they are.

**The lock dies too early.** `runExclusive` takes `pg_advisory_xact_lock`, which is
released when its transaction ends. The write flow spans three transactions and a
Git commit, so a transaction-scoped lock would be gone before the Git commit.

**Retry would commit twice.** `withRetry` re-runs a whole callback on a
serialisation failure. A callback that has already committed to Git would commit
the same change again.

**A step cannot read its own writes.** Repositories read through the pool. Appending
the ledger event reads the previous sequence, and in the final transaction that read
has to see what the same transaction just wrote.

## Decision

### The lock is session-scoped, on a connection of its own

`pg_advisory_lock(LOCK_WORKSPACE_WRITE, hashtext(workspace_id))` on a dedicated
pooled connection, released in a finally. The migration runner already does this and
is the proof that the shape works.

A process that dies loses its connection, and PostgreSQL releases the lock. What is
left behind is the operation row, which is what recovery is for. A lock that
survived a dead process would need an expiry, and an expiry is a second way to get
two writers.

Consequence: one connection per concurrent cross-store write. The pool minimum is
documented alongside it.

### Retry moves inside the steps

The primitive does not retry the operation. Each PostgreSQL transaction inside it
may retry on 40001 and 40P01, because each is pure database work. The Git commit is
never retried automatically: a failure leaves the operation `pending`, and recovery
marks it `failed`.

### Reads take an explicit transaction

Repository methods that a step must read inside its own transaction take the
transaction as an argument. The alternative, an ambient transaction through
AsyncLocalStorage, reads better at the call site but makes it invisible which reads
join a transaction, and a read that silently joins one is a bug nobody can see.

### The operation row carries the request context

Recovery rebuilds a ledger event for an operation that reached Git but not
PostgreSQL. CLAUDE.md rule 3 requires every material write to record the actor type
and id, the agent, the client, the model, the session and the request id. The Git
trailers carry the workspace, actor, agent, proposal and the per-revision changes.
They do not carry the request id, session, client, provider or model.

So the operation row stores them. Without that, a recovered event would be missing
fields the rule requires, and the ledger would record less for a recovered write
than for an ordinary one.

### The taxonomy version is allocated early and stamped late

`taxonomy.yaml` is rewritten in the same commit as any taxonomy mutation, so every
taxonomy mutation is a cross-store operation with a version number.

The number is allocated in the pending transaction, so two concurrent operations
cannot claim the same one, and `git_commit_hash` on the version row is filled in the
final transaction, because before the commit there is no hash to store.

## Consequences

- Taxonomy mutations become the first cross-store writers and the test vehicle for
  failure between the stages, before any knowledge model exists.
- `runExclusive` keeps its transaction-scoped meaning for single-transaction work
  such as bootstrap. The new primitive is separate rather than a widening of it, so
  no existing caller silently changes behaviour.
- A cross-store write needs a spare connection. On a pool of one it cannot proceed,
  which is a startup-time check rather than a runtime surprise.
