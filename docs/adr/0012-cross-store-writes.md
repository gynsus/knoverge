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

### The lock is session-scoped, on a connection of its own, behind an in-process queue

`pg_advisory_lock(LOCK_WORKSPACE_WRITE, hashtext(workspace_id))` on a dedicated
pooled connection, released in a finally. The migration runner already does this and
is the proof that the shape works.

A process that dies loses its connection, and PostgreSQL releases the lock. What is
left behind is the operation row, which is what recovery is for. A lock that
survived a dead process would need an expiry, and an expiry is a second way to get
two writers.

A write needs **two** connections at its peak: the one holding the lock for the whole
write, and one for each transaction it opens in between. If waiting writers each held
a connection, enough concurrent writes would take the whole pool and the one writer
that holds the lock could not open the transaction that would let it finish — a
deadlock with no timeout, because a pool wait has no deadline by default.

So writers to one workspace queue in memory first, and only the one at the head takes
a connection and asks PostgreSQL. Waiting then costs a promise rather than a
connection, and the advisory lock behind the queue is still what makes the exclusion
real, because a second process shares no memory with this one. `lock_timeout` bounds
the wait server-side, so a lock held by a backend whose client is gone answers rather
than hanging, and the connection is destroyed rather than returned to the pool if the
unlock does not report success — a session-scoped lock outlives the query that took
it, and a pooled connection is not a session that ends.

Consequence: the pool must have room for the number of workspaces written to at once,
plus headroom for reads. Four is the floor for a single-workspace installation.

### Retry moves inside the steps

The primitive does not retry the operation. Each PostgreSQL transaction inside it
may retry on 40001 and 40P01, because each is pure database work. The Git commit is
never retried automatically.

When the commit step throws, the primitive asks Git whether a commit naming the
operation exists before deciding what the row says. The store commits and then reads
the hash back, so a failure between the two throws although the commit happened.
`failed` is terminal — recovery never examines it again — so closing such an
operation would abandon a commit that is already in history. A commit that may exist
leaves the row `pending`, with the error recorded, for recovery to decide.

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

### The taxonomy version is chosen under the lock and written with its commit

`taxonomy.yaml` is rewritten in the same commit as any taxonomy mutation, so every
taxonomy mutation is a cross-store operation with a version number.

The number is `latest + 1`, read inside the commit step. The workspace write lock
excludes every other writer for the whole operation, so the number cannot be taken
twice and does not need reserving first; the unique index on `(workspace, version)` is
the backstop. The row itself is inserted in the final transaction, with its commit
hash, because before the commit there is no hash to store and a version row without
one would describe a state no commit produced.

An earlier draft of this ADR said the number was allocated in the pending
transaction. That would not have helped: what it was meant to prevent is a crashed
write's number being taken by the next one, and the rule below is what actually
prevents it.

### A workspace with an unfinished operation refuses to be written to

An interrupted write leaves the repository holding a change PostgreSQL does not have.
The next write re-renders the whole file from the database, so it would silently
delete the committed change and take its version number — two commits claiming one
version, and a category deleted from the canonical file by an unrelated operation,
with nothing anywhere saying so.

So a write refuses to start while the workspace holds a `pending` or `git_committed`
operation. The two stores disagree and the process cannot tell which is right;
stopping is the only answer that does not destroy something. Recovery runs at
startup, before anything is served, so the ordinary case is that a workspace is never
seen in this state.

## Consequences

- Taxonomy mutations become the first cross-store writers and the test vehicle for
  failure between the stages, before any knowledge model exists.
- `runExclusive` keeps its transaction-scoped meaning for single-transaction work
  such as bootstrap. The new primitive is separate rather than a widening of it, so
  no existing caller silently changes behaviour.
- A cross-store write needs a spare connection, so the pool is sized for concurrent
  writes plus reads, and every pool wait, statement and idle transaction is bounded:
  an exhausted pool has to produce a failed request, never a process that stops
  answering.
- A crash between the Git commit and the PostgreSQL transaction blocks its workspace
  until recovery resolves it. A knowledge write is resolved at the next startup from
  the commit alone. A taxonomy write is not yet: a taxonomy commit names no
  per-category change, so it is reported as unresolved and the workspace stays closed
  to writes — loud and safe, rather than quiet and wrong.
