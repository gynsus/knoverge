# Codebase Conventions

How the packages fit together and the patterns every feature follows. `CLAUDE.md` lists package responsibilities; this document describes the mechanics.

## 1. Layering

```text
contracts   Zod schemas, enums, ids, error codes. No runtime dependencies on other packages.
core        Domain services and ports (interfaces). Depends on contracts and policy.
db          Drizzle schema, migrations, repositories implementing core ports, unit of work.
git-store   Markdown, hashing, slugs, taxonomy.yaml, Git operations.
search      Projections and retrieval implementing core ports.
auth        Password and token hashing primitives.
backups     Taking one consistent copy: the dump, the archive, the manifest, rotation.
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

A write that takes more than one lock takes them in this order: the workspace write lock held across a whole canonical write, then named locks from `runExclusive`, then the taxonomy version lock of a workspace, then the event ledger lock. Any other order can deadlock two transactions against each other. Deadlocks and serialisation failures are retried a few times inside the unit of work, so ordinary contention does not reach the caller as an internal error.

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

The rules a new screen follows — what belongs in a drawer, why a dialog is
never hidden with a class, where permissions come from — are in `WEB_UI.md`.

## Choosing a workspace in the browser

A person can belong to several workspaces, and the server refuses a request
that names none of them. `apps/web/src/auth/use-workspace.ts` holds the choice,
sends it as `X-Knoverge-Workspace` on every request, and remembers it per
browser. The switcher sits at the top of the sidebar and is shown whatever the
number of workspaces: a control that appears the day a second one exists is a
control nobody finds, and it is also the answer to "where am I", which somebody
returning to a tab asks more often than "take me elsewhere". Choosing another
workspace clears every cached query but the authentication one: the page keys
are not scoped by workspace, so without that the previous workspace's rows would
stay on screen under the new one's name.

`apps/web/src/pages/WorkspacesPage.tsx` lists them with what each holds, and
`/workspaces/settings` holds the settings of the one currently selected. The old
singular addresses redirect, because a rename should not turn somebody's open
tab into a blank page.

The same hook reports what the caller may do, which `/v1/workspace.get` returns
as `permissions`. Navigation entries and mutation controls are shown from that,
not from the membership role: the server gates on the permission, and a second
copy of the rule in the browser drifts from it. A reviewer granted an action
explicitly would otherwise be shown a control they are entitled to use, and a
viewer would be shown forms whose every submission is refused.

## Search

The parts are split by what they know. `packages/search` holds what retrieval
decides — how text becomes chunks, and how two opinions about relevance become
one number. `packages/db` holds the SQL, because that is what a repository is
for. `packages/core` holds the service that calls both, and
`packages/intelligence` the provider port an embedding needs. ADR 0020 records
why, and why the chunker is deterministic: an index nobody can reproduce from
the canonical files is a second source of truth.

`search_chunks` is a projection of canonical content, written in the same
transaction as the revision it describes. `ARCHITECTURE.md` describes
projections as jobs, which is right for an embedding — that needs a provider
and can fail. A tsvector needs nothing but the text, so writing it with the
revision costs nothing and means a search never disagrees with what was just
written. Recovery writes it too, for a change that reached Git and no further.

Nothing there is authoritative: losing the table costs a `knoverge db reindex`,
which reads every file from the repository and rebuilds the rows, and costs no
knowledge at all. The server fills the gaps at startup, for knowledge recorded
before the index existed or restored from a backup that predates it — a search
that quietly finds nothing gives an operator no reason to suspect it.

## Filtering belongs in the query

Several tools answer "some of what the workspace holds", and each one asks the
database for exactly that rather than for a page of everything. A page taken
first and filtered afterwards is wrong in a way that never announces itself: a
briefing built from the first two hundred items by creation order describes the
oldest corner of the workspace, and a digest built from the first five thousand
events says nothing happened yesterday. Both did, until an audit asked what
happens past the first page.

## One contract, two transports

`packages/contracts/src/tools.ts` lists every operation offered as a tool: its
name, its description, its input and output schemas, and whether it writes.
That list is the contract rule 11 means. `apps/server/src/routes/tools.ts`
generates `POST /v1/<tool_name>` from it, one route per entry, and holds the
map from tool name to handler — a map the compiler requires to be exactly the
set of tools, so a tool added to the contract with no handler fails the build
rather than being advertised and then answering 404.

A read that a browser also uses keeps its `GET` beside the tool route, over the
same handler function (ADR 0011). The handler takes the parsed input and the
request; the request is there for what the input does not carry — who is
calling, which workspace, and the idempotency key.

## What a briefing decides

`apps/server/src/routes/briefing.ts` orders items by how far the workspace
trusts them — review state, evidence state, and a heavy penalty for disputed —
and then by how recent they are. A disputed item sits below everything else on
purpose: a briefing that hides a contradiction is how the contradiction gets
acted on, and one that leads with it is how it gets resolved.

When the character budget runs out, an item is abridged to its opening
paragraph before any item is dropped, because half an instruction is worth more
than none of it. `truncated` says when something went, so a caller narrows the
request rather than treating a short answer as the whole picture.

## The MCP endpoint

`apps/server/src/routes/mcp.ts` serves `/mcp` over Streamable HTTP, driven by
the same `TOOLS` list the HTTP routes are generated from and calling the same
handlers. One MCP server is built per request, with its tools closed over the
Fastify request: that is what carries the credential, the workspace and the
idempotency key, and it is also why no session is needed — nothing persists
between calls that the credential does not already establish.

A refusal comes back as a tool error carrying the same `ApiError` payload the
HTTP transport answers with, as text, because MCP has no status codes. The
SDK does not apply a tool's output schema to an error result, so the error
shape travels intact.

A tool call's provenance arrives in MCP's `_meta` rather than in headers. The
endpoint puts it on the request as `callMeta`, and `contextMeta` reads either,
so rule 3 records the same thing whichever transport the call came in on.

## The review inbox

`apps/web/src/pages/ReviewPage.tsx` is where an agent's proposals become the
workspace's knowledge. It appears in the navigation only for somebody holding
`knowledge.approve`.

It is a queue beside a decision rather than a list with a drawer, which is
rule 1's one exception: every decision here is followed by the next, so a
drawer would cost an open and a close per proposal and hide how much is left.
Below the large breakpoint the decision opens over the queue, and `lib/
use-media-query.ts` decides which of the two exists — a panel rendered in both
and hidden with a class is two of every field and two effects fighting over the
focus.

The counts across the top are the filters: waiting, conflicts, new items,
changes, today. Oldest first, because what has waited longest is what to look
at, except that a conflict sorts above everything — that is somebody's work
about to be lost.

`components/review/ProposalDetail.tsx` answers, in order, the questions a
decision rests on: why this is waiting, where it would land, what it would
change, and what it rests on. The reason is read off the record — the policy
decision, the status, the payload — rather than stored as a sentence, so it
cannot drift from what is true. The panel opens as the proposal and becomes a
form only when somebody asks to change it before approving.

A proposal against an existing item is shown as a diff against what that item
says now. Approving without seeing that is approving a change nobody read,
which is the one thing a review is for. A reviewer who edits the text before
approving sends it as `edits`, and the proposal records `approved_with_edits`,
so the trail never claims the proposer wrote words they never saw. Rejecting
opens a dialog that asks why, with the sentences somebody would otherwise type
offered and still editable: "rejected, no reason given" teaches an agent
nothing.

Postponing is in the row of actions, marked, and does nothing. A proposal has
no postponed state, and inventing one in the browser would be a queue only that
browser agreed with.

Category proposals are not here. They are decided with the taxonomy, because
the decision is about the tree — what already sounds like the proposed
category, what would go in it, where it would hang — and none of that is on
this screen. The queue says how many are waiting there rather than dropping
them silently.

## Our own policy blocking our own bundle

`style-src 'self'` carries one nonce, minted per response in
`plugins/security.ts` and read back by `cspNonceOf`. It exists for exactly one
consumer: Radix locks the page scroll through `react-remove-scroll`, which injects
a `<style>` element for the scrollbar width, and for as long as the policy had no
allowance every dialog and popover logged a violation and the page jumped.

The value travels on a `<meta name="csp-nonce">` in the shell, which `main.tsx`
hands to `setNonce` from `get-nonce` — the API that stack already has for this.
Not through an inline script, which would have needed its own nonce in
`script-src` and widened the directive that is currently the tight one.

That is why `app.ts` serves the shell from memory rather than as a file, and why
it is `no-store`: the file is the same on every request and the nonce is not.

## Removing a category

Three operations, and only one of them is a delete.

**Merge** is what removal means for a category people used. It moves the items,
the direct children and the aliases to the survivor, leaves the closed category
in the tree with status `merged` and a pointer to where its contents went, and
turns its old path into an alias of the survivor so an agent that recorded that
path still resolves. **Archive** hides a category and its subtree without
touching either.

**Delete** is for a category that never meant anything: created by mistake, never
filed under, and archiving it would describe it for ever as something the
workspace used to use. `TaxonomyService.assertNothingDependsOn` refuses unless
every condition holds and says which one failed — descendants, items, aliases,
proposals, grants and policy rules, and a `merged` status. Each is something that
would otherwise break quietly, and two of them are worth naming: the items key is
`restrict`, so the check exists to answer in words rather than in a constraint
violation; the proposals key is `cascade`, so that is the case where the database
would say nothing and the loss would be real (ADR 0025).

Grants and policy rules keep their category scope as JSON with no foreign key, so
nothing in the database would object to deleting a category out from under one.
The service asks through a `references` port rather than learning their shape:
the list of things that may name a category grows.

Recovery has its one special case here. Every other taxonomy change leaves the
category in the committed file and is rebuilt from it; a delete is the change
whose evidence is an absence, so recovery reads a *missing* entry as the delete
having happened and removes the row.

What recovery rebuilds from a commit is everything the file carries, and the list
is worth stating because one of them was missing for a while: the item and its
revision, its categories and tags, the search index, the relations, what a summary
was made from — and the sources the revision rested on. The frontmatter is the
portable copy of each of those and PostgreSQL is the queryable one, so a revision
recovered without its source rows cites a page in its own text while the database
says nothing rests on it, and "which items came out of this attachment" answers
nothing (ADR 0008). `packages/core/src/knowledge/sources.ts` is the one place that
writes them, shared by the ordinary write and by recovery, because the two have to
agree.

## Working with the taxonomy in the browser

`apps/web/src/pages/TaxonomyPage.tsx` is a tree beside a panel, not a list with
a form under it. A category here is not a folder: it carries guidance that tells
an agent what belongs in it, aliases that let it be found under another name,
counts, and a record of who made it. None of that fits on a row, so the tree
keeps the shape and `components/taxonomy/CategoryDetails.tsx` holds the
category. Below the large breakpoint the panel becomes a sheet.

Search covers names, paths, aliases and descriptions, and a match keeps its
ancestors — `lib/taxonomy-tree.ts` works that out — or a match three levels down
would hang from nothing and the tree would have lost the one thing it is for.

Creating and editing happen in a sheet rather than a permanent form, and moving
and merging in dialogs that say what will happen before it does. Moving is
deliberately not drag and drop: it rewrites the repository's directory layout
and the scope of every permission written against those categories, and a
gesture that can be made by accident is the wrong way to ask for that. Archive
is offered where delete would be, because a category holds knowledge.

Categories an agent has asked for sit above the tree rather than in it: a
proposed category has no id and no path until somebody makes it, and putting it
among the real ones would claim it exists. Choosing one shows who asked, why,
what they would file there, and the categories that already sound close —
matched by a shared word in the name and labelled as such, because nothing
compares categories by meaning.

Approving one is not offered. Making the category out of the proposal is this
service's own create and the review workflow does not reach it yet, so the
buttons are the two that work: create it with the proposal's answers already in
the form, or reject it. The sentence under them says why there is no third.

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

## A contradiction has two ends

`packages/core/src/knowledge/disputes.ts` holds the whole rule for `disputed`,
which is derived and which nothing sets (ADR 0022): an item is disputed while a
live `contradicts` relation connects it to another item, in either direction,
that is still active and whose validity window overlaps its own.

The relation lives on the item that reported it, so marking the other one means
writing the other one's file — a second revision in the same commit, exactly as
a supersession writes two. `KnowledgeService.planDisputes` computes the verdicts
for the items a write changes together with the partner files it flips, and
`recordDisputes` writes those partner revisions. It takes every changed item at
once because a supersession changes two and each one's verdict can depend on the
other's new state.

The fan-out is one level deep, and that is the property that makes this safe to
put in five operations: a verdict is decided by status and validity windows, and
recomputing a verdict changes neither. There is no cascade to bound.

## What a claim rests on

`evidenceFrom` in `packages/core/src/knowledge/frontmatter.ts` is the whole of
it, and it counts origins rather than entries (ADR 0026). Three sections of one
document are one publisher agreeing with itself; a page and a write-up of it on
another site are two. A source whose role is `derived` came out of another of
these, and one whose role is `contradicting` argues the other way — neither is
support, and the role vocabulary already said so before anything read it.

Derived at every write, like `disputed` and `stale`, and for the same reason: a
value a reviewer set once stays where it was put, and the sources move.

## A summary is stale by arithmetic

`summary_dependencies` stores what a summary was made from as pairs of item and
revision, and `packages/db/src/repositories/summaries.ts` holds `isStale()` — the
one SQL expression that decides whether a summary has fallen behind. The filter
on the list, the count behind the pile and the flag on a search hit all call it,
because three copies of that rule would be three chances to write it differently
and only one of them would be noticed.

There is no flag and no job (ADR 0024). A source is written, and every summary
that named its old revision is stale in the same instant — nothing has to catch
up, so nothing can be wrong while it does. Writing the summary again, naming what
is current, is the only way out, and it is the honest one: it means somebody read
them.

`KnowledgeService.staleAfter` answers the same question inside a write's own
transaction, because a caller may legitimately name an older revision — you
summarise what you read, and it may have moved on while you were writing — so a
write cannot assume its answer is no.

## What a digest says, and what it will not invent

`activity_digest` counts a period and lists what changed in it, and every entry
leads somewhere: a changed item carries the revision its last change produced, a
resolved proposal carries the item it was about and the revision an approval
wrote. Without those, a digest is a wall — a reader has to fetch the item and work
out which revision was meant.

`packages/core/src/ledger/narrative.ts` is the optional paragraph on top, and
what it is *given* is the point. It gets the digest's own tally: counts, titles,
change kinds, how many proposals went each way. It never gets knowledge text. A
digest says what happened in a workspace, not what the workspace knows, and a
model handed the knowledge would write the second one.

The instruction tells it not to guess why anything happened, not to judge it and
not to say what should be done — a digest that invents a reason is worse than a
list. It is off by default, because it costs a call and the counts are the
answer, and it answers null rather than refusing when nothing is configured: an
absent optional feature does not make a missing digest (rule 9).

## Drafting a summary, and never writing one

`packages/core/src/knowledge/drafting.ts` reads the named items at whatever
revision each is at now, sends their bodies to the generation provider and hands
back a body plus those revisions. It drafts and it does not write: what comes back
goes through the ordinary create or update, which is where provenance, review and
Git already live. A path that generated knowledge and committed it in one step
would be a way for a model to put words in the ledger that nobody read.

Three things the prompt does deliberately. The instruction is the system message
and the knowledge is the user message, never concatenated, so a passage saying
"ignore your instructions" says it in the voice of somebody being quoted. Each
source is titled and fenced, so one cannot run into the next. And the instruction
asks the model to report a disagreement rather than resolve one, because a summary
that quietly decides which of two sources was right is worse than no summary.

`POST /v1/admin/knowledge.draft_summary` needs `knowledge.write`, because the only
thing worth doing with a draft is saving it. It is not a tool: an agent has its
own model, and rule 5 says an agent's contribution arrives as a proposal rather
than through the server's.

## What a proposal carries

A pending proposal is applied from its payload and from nothing else. That makes
the payload the only copy of what was proposed, and every field it does not carry
a field that approving the proposal silently drops — no error, nothing on the
screen, and an item that differs from the one a policy rule would have written
directly.

It happened three times. An external key went missing and took the
external-identity half of reconciliation with it. A validity window arrived in
milestone 7 and reached the request, the file and the direct write, but not the
payload. A summary's dependencies arrived in milestone 8 and did the same, which
left a reviewer-approved summary with nothing to go stale against — rule 7, gone
by omission.

The cause was arithmetic rather than carelessness: the fields of an item were
written out by hand in six places. The admin create, the admin update, the three
propose routes and a supersession's replacement each mapped the request onto the
domain, and the proposal service mapped the domain onto the payload and back.
Seven lists, no two of them checked against each other.

Two things hold it together now. `packages/contracts` owns the payload's schema,
so what a proposal may carry is stated once, and `ProposalEdits` is derived from
it — a field a proposal can carry is a field a reviewer can correct.
`apps/server/src/routes/knowledge-input.ts` owns the wire-to-domain mapping for
every route that writes an item. Both use the same guard: the fields are
destructured and what is left over is passed to a function that accepts only an
empty object, so the next field added to the contract is a compile error at each
place that would have forgotten it.

The payload is read back through its schema rather than cast. A stored payload is
data — written by an older version of the code, possibly edited by a reviewer,
kept for as long as the proposal waits — and one that cannot be read is refused
rather than half-applied.

## Whether the two stores still agree

`packages/core/src/integrity/service.ts` reads what is on disk and compares it with
what the database recorded, workspace by workspace: unfinished operations, the
ledger's hash chain, every item's commit and file, the file's frontmatter against
the revision's, and `taxonomy.yaml` against the categories table.

Three decisions worth keeping.

**It reads and never writes.** A checker that repaired things would be a fourth way
knowledge changes, next to a write, a proposal and recovery, and the least reviewed
of the four. What can be repaired is `db recover`'s job; what cannot is the backup's.

**A deleted item is checked at its commit.** Its file is gone from the working tree
and present in every commit that had it, so the check reads it with `readAt` — which
is the only way to reach the half of the repository a working-tree listing cannot
see.

**A finding names objects and fields, never text.** A frontmatter disagreement says
which fields disagree, not what they say; a content mismatch says the two hashes.
The report goes into logs and into a script's output, and knowledge does not belong
in either. That is the same rule the ledger follows (rule 4).

One false positive is worth knowing about, because it failed the first run: a
workspace nobody has filed anything in has no `taxonomy.yaml` yet, so a missing file
is only a finding when the database holds categories.

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

## Knowledge in the browser

`apps/web/src/pages/KnowledgePage.tsx` is a dense list, not a grid of cards:
there may be thousands of items, so scanning and narrowing beat browsing. The
Git path is deliberately not in a row — it was the widest thing in every one
and the least useful — and lives in the drawer where somebody asks for it.

Four piles across the top say how big they are and open exactly what they
counted: everything, what nobody has checked, what nothing backs, what the
workspace contradicts itself about. The counts come from
`GET /v1/knowledge.counts` because a list that pages cannot say how much there
is, and a number describing the fifty rows that happen to be loaded while
claiming to describe the workspace is worse than no number. Each one counts what
its filter returns; a count that opens a different list is read as a fact and is
wrong.

`components/knowledge/ItemDetails.tsx` opens as the item and not as a form,
because reading knowledge and changing it are different acts and a ledger is
the wrong place to blur them. It is three tabs — the item, its history, its
connections — which is where it stops: three is the number of questions
somebody has about one item. Sources stay with the item, because reading where
something came from is part of reading it.

The drawer states when a claim holds even when nothing was said, because
"always" is an answer and a blank row is not, and it says when a period has
passed. `components/knowledge/validity.ts` holds the conversions between the
instants the contract carries and the days the form offers, and
`Validity.tsx` holds both ends of it: the sentence in the drawer and the three
date fields in the editor. Until they existed, `valid_from` and `valid_until`
were settable only through the API — and since ADR 0022 they are how a person
resolves a contradiction between two claims that were each true in their own
period, so the browser could state the problem and not the answer.

The history fetches what a revision changed only when asked. Forty revisions
would otherwise be forty diffs nobody read, each one two files out of Git. What
changed *about* the item is answered field by field; the patch is for the text.

Arrow keys walk the list, Enter opens, `e` edits, `n` starts a new item, and
the list of them is on the screen. None of them writes: a single key that saved
or deleted is a single key somebody presses while reading. Enter's key-down is
prevented, or the key-up lands on the close button the opening panel just took
the focus to.

The open item is in the address. Rule 2's test is whether somebody else may
need to arrive at the same thing, and "here is what we decided: <link>" is the
most likely sentence anybody writes about one.

One item has three references, and the menu offers all three because they are
for three different readers. A **link** is for a person and is what the address
made possible. The **id** is what an agent calls it and what `knowledge_get`
takes; it is on screen as well as on the clipboard, because nothing else said
it. The **path in Git** is for a shell: `git log --follow` on it gives an
item's whole history across the category moves that rename it, which is rule 1
holding — the knowledge is readable, and checkable, without the application.

## Connecting a provider

`apps/web/src/pages/AiSettingsPage.tsx` and `components/settings/
ProviderWizard.tsx` are where an operator points the product at an Ollama and
picks a model. ADR 0021 records why that is configuration the product owns
rather than environment variables: every step of choosing a provider is
iteration, and each one used to need a container restart.

Both checks run against the address in the field rather than a saved row. A
form that can only test what has already been stored teaches people to store
things that do not work. The model list is filtered by the capabilities the
provider reports, so a generative model cannot be chosen to make vectors nor an
embedding model to write text.

There are four purposes and each is chosen separately, because they are separate
questions and, on most installations, separate models. `embedding` feeds the
vector half of search and the semantic steps of duplicate detection and
reconciliation; `generation` writes summaries and the optional narrative on a
digest; `vision` looks at a picture; `transcription` listens to a recording. One
provider can hold several, and stopping one leaves the others alone.

`transcription` is the one purpose that is not offered from every provider.
Ollama has no endpoint that takes a recording, so the screen offers it from the
providers that could answer it, the service refuses an assignment to one that
could not, and `transcription_enabled` reads the assigned provider's kind rather
than the assignment alone — a provider can be edited into a different kind after
it was assigned.

The second check differs by purpose because there is no one answer for all four.
For an embedding model it reports the dimension — the number the whole index
hangs from and the one nobody configures. For a generation model it reports the
sentence the model actually wrote, because a model that answers in a hundred
milliseconds and says nothing useful has not worked, and a tick would say it had.
For a vision model it sends a red square and shows the answer. For a
transcription model there is no check at all, and the wizard says so.

`packages/intelligence/src/generation.ts` keeps the instruction and the material
in separate messages: one is the product's instruction and the other is
knowledge somebody else wrote, and concatenating them is how material saying
"ignore your instructions" gets to say it in the same voice as the instructions.

A provider's API key is kept the way a webhook's signing secret is: sealed with
`KNOVERGE_ENCRYPTION_KEY`, sent on every call, never served back (ADR 0033). The
wizard offers the field only for `openai_compatible`, because Ollama has no use
for one, and only when the installation has an encryption key — otherwise it says
which variable to set rather than showing a field that refuses. A save that leaves
the field out keeps the stored key, so a rename does not drop a credential; `null`
clears it.

`packages/core/src/ai/service.ts` holds the built embedding provider between
calls. That is not an optimisation: `EmbeddingProvider` learns its dimension from
the model's first answer, and a fresh instance per call would report zero for
ever, which is how a profile fails to be recognised. What it is keyed by includes
the sealed key, so a key changed on the settings page is noticed by a worker in
another process rather than after a restart. The generation provider is
built fresh every time, because it learns nothing and so has nothing to lose.

## Agents in the browser

`apps/web/src/pages/AgentsPage.tsx` is access management, not a token list. The
columns are the questions asked of a list of agents: who is this, what may it
do, what is it, is it working, when did it last do anything.

**Registered and never connected is not the same as working**, and both used to
read `active`. `components/agents/connection.ts` draws the three states the
list actually needs, because the question after issuing a credential is whether
the agent got in.

The interface says **access**, not trust tier. `trusted` is the name of a tier
and not a promise: it says the workspace policy may let this agent write
without review, and until a policy rule says so it does not. The hint under the
control says exactly that, because "trusted" reads as "may do anything".

`components/agents/AgentDetails.tsx` is four tabs — overview, access,
credentials, activity. Narrowing an agent to certain categories is in the model
already, since a permission grant names a category and whether it reaches what
is under it; there is no screen for it, so the access tab says so rather than
leaving somebody to assume an agent is narrower than it is.

A credential is issued with a name and a lifetime, and the screen that shows
its token has no corner cross: it is the only copy there will ever be, and a
cross that refuses reads as broken. It also carries the MCP configuration for
this installation with the token in it, so registering an agent and connecting
one are the same minute rather than a trip to the documentation.

The activity tab is the ledger narrowed to one actor, newest first —
`events_list` takes `actor_id` for a caller holding `events.read_all`, and
narrows to the caller's own for anybody else, so naming an actor is not a way
of reading about one you cannot see.

## The ledger in the browser

`apps/web/src/pages/LedgerPage.tsx` is the screen the product is named after.
Until it existed, events were visible on an agent's card and in a category's
history, and `activity_digest` had no interface at all: the one feature that says
what a week came to was reachable only by an agent.

Two bands, because a reader arrives with two questions. The summary is the digest
— counts, the items it touched and the proposals it decided, each leading to the
thing itself. The feed below is the chain, newest first, read backwards a page at
a time through `before_sequence`. Reading a descending feed with
`after_sequence` hands back the newest page for ever, which is the defect that
put `before_sequence` in the contract.

**One vocabulary for the whole screen.** The digest names a change by its event
type with the prefix taken off — `updated`, `approved` — so both bands label them
through `events.types.*`, and "Item changed" means the same thing in the summary
and in the feed. A test holds that every event type has a label in every locale:
an unnamed one falls back to the enum, which is the schema leaking into the
product.

`components/ledger/groups.ts` is the filter. Fifty types in a select is a list
nobody reads, so a group is a set of types and not a prefix:
`knowledge.proposed_create` belongs with the proposals, `command.denied` with
them too. A test holds that every type is in exactly one group — a type in none is
one the filter hides without saying so, and a type in two is one whose count a
reader meets twice. The group is sent to the server as `event_types`, because the
page is paged and filtering the page in the browser answers a question nobody
asked.

The narrative is a button. It costs a model call, it answers null when nothing is
configured, and the counts are the digest without it (rule 9) — so the screen says
which model wrote the paragraph, and says plainly that none is configured rather
than leaving the button to do nothing. Both the longer period and the prose keep
the previous counts on screen while they are fetched, because it is the same
summary either side of the wait.

Without `events.read_all` both bands answer with the reader's own events, and the
page says so. A quiet ledger and a narrowed one look identical, and "nothing
happened" is the wrong thing for somebody to conclude about a workspace they can
only see their own corner of. The line waits for the permissions to arrive rather
than flashing while they do — `can` is false before the answer comes back.

## The other end of a supersession

The replacement carries the relation and the replaced item carries
`superseded_by` in its frontmatter: one fact, written twice, in the two files that
need it (ADR 0015). `KnowledgeItemDetail` served the relation and not the
projection, so an item whose status read `superseded` answered nothing about what
replaced it — the one question that status raises, and the one thing a reader
needs next.

It is served from the revision, like `disputed_by` and `summary_of`, so reading an
older revision says what that revision said. It survives
`include_relations: false` for the same reason the `disputed` flag does: an item
that is no longer current has exactly one thing a reader has to follow, and
withholding it makes the status unanswerable.

## Naming the model that phrased the text

`drafted_by` is a frontmatter field and nothing else: no column, no migration, no
event field. The wording belongs to a revision, and the revision already stores its
frontmatter, so the file a person reads without the application answers the question
and a read of an older revision answers it as that revision did (ADR 0031).

Two places decide its value, and both are one line. `KnowledgeService.create` writes
it when the caller named a model. `update` keeps it when the body is not part of the
write, and deletes it when the body changes without a model being named again — so a
tag edit does not make a drafted summary hand-written, and a rewrite does not leave a
model's name on somebody's own sentences. The proposal path carries it in the payload
and drops it when a reviewer edits the body, for the same reason: a reviewer who
rewrote the text is its author.

The browser fills it from the drafting control, which knows which model answered, and
sends it only when the body on the screen is that answer.

## Pushing a notification out of the installation

`packages/core/src/webhooks/service.ts` is the only place this product calls a host
it was not asked about, and rule 12 is why the asking is the whole feature.

What leaves is an event and never an object (ADR 0029). The summariser is in the
domain rather than borrowed from the server's `events_list`, because the rule about
what may leave belongs where the rule lives, and a webhook is the one door it leaves
through. A test reads the delivered JSON and asserts the field names exactly, so a
field added later has to be considered rather than delivered.

Delivery is a cursor, not a queue. Each endpoint holds the last workspace sequence it
was told about, so a failure leaves it where it was and the next sweep resends — at
least once and in order, with no table of individual deliveries to grow. The same
primitive an agent uses through `knowledge_changes` (ADR 0010).

`pg_dump`-style seams again: `post` is injectable, so the test is a real HTTP
receiver on a loopback port rather than a mocked `fetch`, and it verifies the
signature by computing the HMAC itself. Calling the product's own `sign` from the
test would have passed whatever `sign` started doing, including dropping the
timestamp out of the signed material — which is exactly the break that caught it.

The signing secret is the only recoverable secret here. `packages/auth/src/sealed.ts`
is AES-256-GCM under `KNOVERGE_ENCRYPTION_KEY`, with a fresh nonce each time so equal
secrets do not look equal in the column, and an authentication tag so an edited row
fails to open rather than opening to something else. Without the key a webhook cannot
be created: refusing beats storing a signing secret an operator believes is encrypted.

Which is a refusal the screen has to make before the form, not after the save, so
`webhooks.list` answers `secret_storage_configured` as well as the endpoints. It is
decided in `createServices` from the configuration rather than in the domain: whether
a key was given to this process is a fact about how it was started, and the sealing
functions that throw without one are already the same answer given later. "You cannot
do this here" and "you may not do this" are different sentences, and only the second
one is about the caller.

`apps/web/src/pages/WebhooksSettingsPage.tsx` is the other half of rule 12. The door
this product calls out through was open only to an operator who would write the
request by hand, and asking for permission in a form nobody can find is not asking.
The screen leads with what leaves — the event and never the knowledge — because
somebody pointing this at a third party is deciding exactly that. The health each row
shows was in `webhooks.list` from the first day and was displayed nowhere, so an
endpoint that stopped working stopped working silently.

## Files a workspace holds

`packages/attachments` is the whole of the storage: a path made of a hash, an
atomic write, a read and an existence check. There is no `storage_path` column
anywhere, because the path *is* the hash — a column would be a second answer to a
question the hash already answers, and after a restore the two could disagree.

The bytes are written before the row, and that order is the decision. A file on
disk with no row is a few kilobytes nobody asked for; a row with no file is a
record of something that is not there, which the integrity check reports as
`attachment_missing` and nothing can repair — an attachment is not in Git and
cannot be rebuilt from anything. So the check looks for the second and not the
first.

Deduplication is per workspace, by content. The same file uploaded twice is one
attachment and the answer says `created: false`, so an uploader who expected a new
id is told which one it is. Not global, because "you already have this" is an
answer that would tell one workspace what another holds.

What the domain refuses — an empty file, one past the installation's limit, a
filename that is a path or carries a line break — it refuses for every transport,
even where the HTTP route gets there first: the multipart parser stops at the limit
and takes the directory off a filename, and the MCP upload will do neither.

An uploaded file is served as a download and never as a page. `SECURITY.md` says
why: an HTML file somebody uploaded, served inline, runs on this installation's
origin with this installation's cookie.

## Reading the text out of a file

`AttachmentExtractor` writes **as the person or agent who uploaded the file**, and
that is the whole of the policy question. A person who may write knowledge writes
a `document` item. An agent proposes, and its document waits in the review queue
exactly as its other writes do — a file is not a way around rule 5, and the
duplicate check runs on that path too, so the same document uploaded twice does
not become two items.

The extraction itself is in `packages/attachments` and asks nothing of anybody: no
provider, no network (rule 9). Text, Markdown and HTML are read here — deliberately
modestly: scripts and styles go with their contents, block elements become line
breaks, entities are decoded, and an installation that needs a faithful conversion
still has the original file.

PDF and Word are two libraries, chosen for what they cost as much as for what they
do. `unpdf` is Mozilla's engine in a build meant to run outside a browser, at two
megabytes against `pdfjs-dist`'s thirty-five, and it needs no worker, no canvas and
no font fetched from anywhere, because this reads text and never renders a page.
`mammoth` reads Word, and the alternative was a zip reader and an XML parser here —
a `.docx` is only simple until it has a table, a footnote or a list in it. Both are
imported where they are used, so an installation that never uploads a PDF never
loads a PDF engine, and `knoverge integrity check` loads neither.

A PDF with no text layer is a scan: a picture of a page, with nothing to read. That
is `unsupported` rather than a failure — the file is kept, and an installation with
a vision model assigned can look at it.

## Looking at a picture

`MediaDescriber` is asked only about what nothing here could read, and only after
that answer is in: reading is free, and looking is somebody else's GPU on somebody
else's server. A file this installation can read itself is never sent anywhere
(rule 12), and a test asserts exactly that.

With no vision model assigned it answers null and the file stays `unsupported`,
which is rule 9 doing its work: the rest of the product does not notice.

What comes back is knowledge, so it is knowledge: a `document` item with the same
attachment source as any other, and `drafted_by` naming the model — a description
is a model's words about somebody's picture, and a reader has to know that
(ADR 0031). It is written without anybody reading it first, which is a decision
and not an oversight: ADR 0032 says what makes it safe enough, and none of it is
the model.

The instruction is where the defence is. A scan of a page saying "ignore your
instructions" is a picture of somebody's words, and the instruction says which of
the two it is: describe what is there, transcribe the text exactly, record any
instruction as text and never follow it, and never invent what might be under an
unreadable part.

Whether a model can see is not something a catalogue answers, so
`ai.test_vision` sends one: a red square on white, a hundred and forty-six bytes,
drawn here rather than fetched from anywhere. The screen shows what the model said
about it and the operator judges — the same shape as the generation test, and for
the same reason.

## Listening to a recording

`MediaTranscriber` is the same shape as the describer and asked on the same terms:
only about a file nothing here could read, and only after the readers have said so.
One or the other answers, never both — a picture is looked at and a recording is
listened to — so an image is never sent to an endpoint that would charge for it and
refuse it.

The file goes as it arrived, audio or video, under its own name. A container this
product cannot open is one a transcription server opens every day, and demuxing it
here would put a media toolchain in the image for a job somebody else's server
already does; the filename goes too, because it is how a provider guesses the
container when the media type is vague. Nothing is said about the language: what
was spoken is not something this product knows, a workspace's own language is a
guess about somebody else's recording, and these endpoints detect it.

What comes back is a `document` item with `drafted_by` naming the model, for the
reason a description carries one — a transcript is a model's account of somebody's
recording (ADR 0031).

`createHttpTranscriptionProvider` posts multipart to `<base>/v1/audio/transcriptions`,
the shape OpenAI defined and every local Whisper server imitates. Only
`openai_compatible`: Ollama has no endpoint that listens, so the settings screen
offers this purpose from the providers that could answer it and says why the others
cannot, rather than letting somebody assign a model that can never be asked. An
error carries the status and nothing else, because the body may quote what was
heard and what was heard is somebody's recording.

There is no probe for this one. A phrase can be embedded, a sentence written and a
red square looked at, but speech is the one thing that cannot be made up here — a
synthesised clip would test the synthesiser — so the wizard says outright that the
first recording is the test instead of showing a tick it did not earn.

Text longer than one item may hold is a failure and not a truncation. Half a
document stored as if it were the whole one is the kind of thing nobody notices
until they rely on it; splitting one file across several items is a decision for
whoever needs it, not a side effect of a size limit.

A file is claimed before it is read, and the claim is the state change: one
statement moves a row from `pending` to `extracting`, so two workers sweeping the
same minute cannot both take it and write the same document twice. Extraction is
the first job in this product that is not idempotent — embedding the same chunk
twice writes the same vector, and reading the same file twice writes two
documents — which is why it is the first one that claims. A worker that dies
holding a claim is noticed by its age: anything left `extracting` for half an hour
is taken again. Half an hour and not ten minutes because the window has to outlast
the longest a single file can take, and the longest is a recording — a
transcription provider is given ten minutes before it is given up on, and a window
equal to that would let the next sweep take a file still being transcribed.

Every ending is written to the row, including the ones that are not failures.
`unsupported` is an answer — the file is kept and can be downloaded — and a file
left `pending` because the sweep crashed on it is the one state the job must never
leave behind, which is why the whole of it is inside the catch.

And every ending that produced nothing can be asked again. The sweep only looks at
files nobody has read yet, which is right until something changes underneath it: a
vision model assigned in April cannot describe a picture that arrived in March, and
a provider unreachable for a minute leaves a file `failed` for good.
`attachments.reread` is the way back into the queue — `unsupported` and `failed`
only, because a file that already became an item would become a second one, and
without an id it takes every such file in the workspace, which is what somebody who
has just connected a model means. The states are chosen inside the statement that
moves them, so a file a worker claimed in between is not taken out from under it.
It is not a ledger event: it moves a row from one kind of "no text yet" to another,
and the write it may lead to records itself as every write does.

It is not a tool either, though uploading, listing and fetching a file are. An
agent that uploaded a file and got `unsupported` would get the same answer asking
again: what makes the answer different is an operator assigning a model, and that
is the person this is for.

## Taking a workspace somewhere else

`knoverge export` is not `knoverge backup` under another name, and ADR 0034 is
about why. A backup is this installation — a dump for a matching PostgreSQL major
version, credentials, permissions, and a ledger keyed with a key that never leaves
the environment. An export is one workspace's knowledge and its history, in a form
`git clone` opens.

The split follows the usual one. `packages/core/src/export/service.ts` decides
*what an export contains*, because that is a rule about this product;
`apps/cli/src/export.ts` writes the directory, because where bytes land is not.
The bundle comes from `git bundle create --all` through the `GitStore` port — a
transport format git itself opens, rather than an archive of this installation's
`.git` with its hooks and stale locks.

The write lock is held for the read, so the bundle and the manifest describe one
moment. The directory is built as `.partial` and renamed at the end, the way a
backup is, so a run that dies leaves nothing an import could mistake for a whole
export. Attachments are copied under their content hash and listed either way,
and a row whose file the store does not hold is named rather than promised.

## Putting one back

`knoverge import` reads what `knoverge export` wrote. `packages/core/src/import/service.ts`
is the domain side and `apps/cli/src/import.ts` the order of operations, and the
order is what makes it work: the workspace row first, because everything is scoped
to it; the repository from the bundle, because it is where the knowledge is; the
taxonomy, because a revision names its categories by path and the rows have to
exist to be pointed at; the attachment rows, because an item made from a file
names one and the source row points at it; then the commits, oldest first.

Replaying a commit is the rebuild `KnowledgeRecovery` does from one commit, done
over every commit — which is why the source writing is shared between them. What
differs is where the pieces come from: recovery has an operation row that says the
path, and an import has only the commit, so the file is found among what that
commit changed and settled by the id in its own frontmatter.

Item ids survive and are globally unique, so an import checks them before writing
anything and says which are taken. An installation that still holds the items
cannot import them again, which is the difference between moving a workspace and
making a second copy of one (ADR 0035). Actors are recreated with new ids and no
user or agent behind them: the interface still says who wrote something, and
nobody gains the ability to write again.

## Taking a copy of the whole installation

`packages/backups` holds the mechanism and nothing else: the two external
programs behind one interface, every workspace's write lock taken in sorted order
and held across both steps, the staging directory renamed into place at the end,
the manifest, and rotation by age.

It is a package for the reason `packages/attachments` is one. The command line
takes a copy when an operator asks, and the scheduled job in the server takes the
same copy on its own (ADR 0040); two implementations would be two formats to
restore, and the one nobody ran by hand would be the one that was wrong.

What is not here is whether to take a copy at all. That is a setting, and
settings are the domain's.

`packages/core/src/backups/service.ts` holds that half. It reads the one row the
migration created, decides whether a copy is due, asks a `BackupStore` port for
one and records what happened — so its tests take milliseconds and never meet
`pg_dump`. The server is what binds the port to the package.

Three decisions live there rather than in a form. A target with no credential to
reach it is refused, and so is one whose stored credential was stored for the
other kind — keeping a key while the form now says password would authenticate
with something nobody chose. A directory on the far machine has to be absolute,
because a relative one lands wherever that account's home is today. And a run
that failed is recorded and returned rather than thrown: the run happened, and
the reason belongs beside the setting, where a failing webhook's already is.

The job asks hourly and almost always answers no, because the interval is the
operator's setting and the schedule is not. It is registered in the worker role
whether or not backups are on: the setting changes while the product runs, and a
queue that appeared only once somebody turned backups on would mean restarting
to turn them on.

### Sending it to the other machine

`packages/backups/src/upload.ts` speaks SSH from this process rather than
shelling out to a binary the image does not carry (ADR 0041). The reasons are
not a preference for libraries: the private key is sealed in the database and
OpenSSH reads a key only from a file, password authentication would need a
second external program that takes the password on a command line, and host key
verification would otherwise be the default of a program configured by a file
that does not exist. It uses SFTP and runs no command on the far machine, so the
account it is given can be restricted to SFTP with no shell.

The far end gets the same staging rename the local copy gets, and for a stronger
reason: it is the machine somebody will restore from without being able to ask
what happened there. The target directory must already exist — a missing one is
an error with the path in it, because the operator typed that path and creating
a tree where they did not mean one is how a backup ends up somewhere nobody
looks.

The host key is pinned on first use, the way `ssh` pins to `known_hosts`. The
first connection stores the fingerprint and every later one requires it; a
changed key fails with a message that says which fact changed. The domain owns
when that pin is forgotten: naming another address clears it, because the pin is
a fact about a machine and the port is part of the address, while a new
credential, directory or username leaves it alone. A refused connection never
pins what answered — that would turn one failure into permission for the next.

`backups.clear_host_key` is the way out of the case nothing else covers: the
target machine was rebuilt, so the host, the port, the account and the directory
are all what the operator typed, and every upload fails. It is its own verb
rather than a field on the form because what it says is about trust and not
about configuration — the next connection accepts whatever answers, once — and
it writes the one column rather than re-saving the row, so a schedule somebody
changed in between is not overwritten by a decision about a key. The log line
carries the fingerprint that was forgotten, because the column that held it is
then empty.

`BackupService.run` therefore has two outcomes rather than one. A copy that was
taken and did not reach the target is a success with a reason beside the target:
the local copy is a backup (ADR 0040), the next run tries again, and the job logs
it as a warning so the only sign is not a field on a screen nobody opened.

`ssh2` is the first dependency this repository does not bundle. The two apps are
single bundled files, which follow a workspace package into its own npm
dependencies — and inside `ssh2` are optional native bindings this installation
deliberately does not build. The library falls back to its own JavaScript when
they are missing, but a bundler resolves them before anything can catch the
failure. So the tsup configs name it external, and both apps declare it, because
`pnpm deploy --prod` installs what an app's own manifest asks for and a
transitive dependency arrives only inside pnpm's private directory, which is not
on the resolution path of the bundle beside it. Externalising without declaring
builds an image that fails on its first import, which is why
`apps/server/test/bundle.test.ts` compares the two lists.

### The screen an operator configures it on

`apps/web/src/pages/StorageSettingsPage.tsx` with
`components/backups/BackupForm.tsx`. One form with one button, because
`backups.save` takes the schedule, the window and the target together and a form
offering three saves would promise a granularity the server has not got
(WEB_UI.md rule 2m). The credential is typed once and the field is emptied on
the way back; omitting it is how an address is changed without finding the key
again, and sending an empty one would clear it.

It leads with what the second machine then holds — the whole database and every
workspace repository — because that is the decision somebody is making, not the
address (WEB_UI.md rule 2o). An installation with no `KNOVERGE_ENCRYPTION_KEY`
is told above the control rather than after the save, and the schedule stays
offered, since a copy on this machine needs no credential.

The pinned host key is on the screen with the `ssh-keyscan` line that checks it,
built from the address that was saved rather than a port somebody has to edit in.
Showing it is the whole of trust on first use: this product cannot tell a rebuilt
machine from somebody in the middle, and a person with shell access to the far
end can. Forgetting it asks first and says what will follow, including the
mistake worth warning about — a failed upload looks exactly like somebody else
answering.

The copies are listed with what is known about each, which for all but the last
one is nothing. `uploaded: null` draws no badge at all: "not sent" of a copy the
settings cannot speak for reports a problem nobody has.

## Letting a hosted connector in

`packages/core/src/oauth/service.ts` is an authorization server whose whole job is
to end in a row `AgentService.authenticate` already knows how to read. An access
token is an `agent_credentials` row with a shorter life and the id of the grant
that issued it, so the routes, the policy, the budgets and the ledger acquire no
second kind of caller (ADR 0038).

`apps/server/src/routes/oauth.ts` holds the protocol surface in a Fastify scope of
its own, for two reasons that both belong to the protocol rather than to this
product: these endpoints answer in OAuth's error shape, and the token endpoint
takes a form body. Encapsulating them keeps both out of every other route.

Three decisions are the whole of its correctness, and each is a place where the
obvious code is wrong.

An authorization code is spent in a transaction of its own, **before** the
verifier is checked. Spending it inside the transaction that also validates it
means a failed check rolls the spending back, and somebody holding a stolen code
can then try verifiers until it expires.

A replayed refresh token revokes the grant **after** the rotation transaction has
rolled back, not inside it. Revoking inside it would be undone by the same
rollback that the refusal causes, so the server would notice the theft and do
nothing about it.

An unmatched redirect URI is refused without a redirect. The URI has not been
matched against a registration yet, which makes it an attacker's URI, and
answering it with an error is the open redirection the specification is warning
about.

## What somebody committed by hand

`packages/core/src/import/adopt.ts` is the database catching up to the repository,
which is what rule 1 implies and what `integrity check` used to only complain
about (ADR 0037). It is the same rebuild as an import, with one thing missing:
there are no trailers, so the frontmatter's own id is what identifies the item.

Two details are the whole of its correctness. It considers every commit filtered
by what the revisions were written by, rather than a range after the newest known
one — a hand-made commit can sit between two of the product's own, and a range
would skip it silently. And a commit that changed a file without changing the
knowledge produces nothing, because a revision saying nothing happened is worse
than no revision.

## A folder of somebody's notes

`knoverge import-folder` is not `knoverge import`, and ADR 0036 is about why. An
export carries items with their own ids into an installation that does not hold
them; a folder is half restatement of what the workspace already has. So it
arrives as an agent does: `sync_begin`, an inventory, and an answer per candidate.

`packages/core/src/importers/folder.ts` is the parser and nothing else — files in,
candidates out — which is what makes the next importer a parser and nothing else
too. `apps/cli/src/import-folder.ts` walks the directory and runs the session.

Two rules in the parser are there because without them nothing would ever match.
The body is hashed without its frontmatter, so a note that gained a tag is the
same text it was. And an opening heading that repeats the title is taken out of
the text, because this product's own files keep the title in the frontmatter
(`GIT_REPOSITORY.md` section 4) — a note that opens with its own title is stating
it, not saying it twice. Both were found by a test that expected a match and did
not get one.

Tags are read from both places people write them and are carried on the candidate
rather than in the inventory: what a note is tagged does not help decide whether
the workspace already holds it, so it is no part of the question — but it is part
of the note, and whatever proposes it has the tags without reading the file again.

That is also the answer to what an Obsidian vault needs: nothing of its own. A
vault is a folder of Markdown with tags and a `.obsidian/` directory that is
skipped like every dot-directory, so it is the same command. `packages/core/src/importers/json.ts` is the second test of the claim, and it
passes it: a parser and a command that submits, with nothing else changed. It is
the path for exports nobody wrote a parser for, so it is forgiving about what
fields are called and strict about what a record has to be — a title and a body,
or it is not knowledge. A record with no id of its own is keyed by its position
and counted, because a positional key is stable only while the file is.

Wikilinks are the one thing that needed a
command of its own: `apps/cli/src/link-from-folder.ts` runs after the proposals
have been accepted, because a relation needs both ends to exist as items. The
parser collects the targets; resolving them is by path first and by the note's own
name second, and an ambiguous name is reported rather than guessed. Every link
becomes `relates_to`, because that is all a wiki link claims.

`apps/cli/src/propose-from-session.ts` is the other half, and it is a separate
command rather than a flag for the reason the ADR gives: an inventory is a
question. It acts on `new_candidate` only, re-reads each file and refuses one
whose fingerprint has moved, drops a suggested category the taxonomy does not
have, and sends the body the parser produced rather than reading the file a
second time with a second idea of where the body starts. The proposal carries the
session id, so a run reads as a run from either end.

## Files on screen

`apps/web/src/pages/FilesPage.tsx` sits beside the knowledge rather than inside it,
because a file is where knowledge came from and is not knowledge itself (ADR 0008).

The link from a file to what came out of it is read from the item's side — a source
of type `attachment` naming the file — which is why `source_references.attachment_id`
is finally populated: the column has been in the schema since the first migration
and nothing wrote to it. `KnowledgeService.itemsFromAttachment` is the query, and it
reads through the current revision only: an item that used to rest on a file and no
longer does is not something that file produced.

An upload is the one request in this product that is not JSON. `apiUpload` sets no
`content-type`, because the browser writes the multipart boundary into it and a
header set by hand would replace the one part of it the parser needs.

## The web interface

Styling is Tailwind CSS; components are shadcn/ui copied into
`apps/web/src/components/ui` rather than installed, so they are our code under
our licence. ADR 0013 records the decision, including why colour is expressed
as semantic tokens with no `dark:` variant, and why a table becomes a labelled
list on a phone.

Forms are `grid gap-4`, and a row of buttons goes in a `flex flex-wrap gap-2`
of its own. Both matter: without the gap the button sits against the last
field, and inside the grid a lone button is stretched across the card.

Fields are grouped with `FieldSet`, or with `FieldGroup` when the group needs a
subheading of its own. The spacing and the heading live in those components
rather than at each call site, because a class list repeated at every form is
the thing that drifts. A `legend` takes no part in the grid's gap, which is why
`FieldGroup` gives it a margin: without one it sits against the first field's
label.

A card that carries the same field labels as another card on the page is given `role="region"` with its title as the accessible name. Two fields called "Text" on one page are indistinguishable to anyone reading them out; the region is what tells them apart.

Three rules follow from it. A cell in `ui/table.tsx` must pass a `label`,
because that heading is what a narrow screen shows beside the value, and lint
requires it to come from the catalogue. Controls inside a cell go in
`TableActions`, because a table cell is not a flex container on a desktop and
is a single unwrapped row on a phone. And the native `select` is used for short
lists of fixed values, because it is what a phone opens as a wheel and what a
screen reader already knows.
