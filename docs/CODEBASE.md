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

There are two purposes and they are chosen separately, because they are separate
questions. `embedding` feeds the vector half of search and the semantic steps of
duplicate detection and reconciliation; `generation` writes summaries and the
optional narrative on a digest. One provider can hold both, and stopping one
leaves the other alone.

The second check differs by purpose because there is no one answer for both. For
an embedding model it reports the dimension — the number the whole index hangs
from and the one nobody configures. For a generation model it reports the
sentence the model actually wrote, because a model that answers in a hundred
milliseconds and says nothing useful has not worked, and a tick would say it
had.

`packages/intelligence/src/generation.ts` keeps the instruction and the material
in separate messages: one is the product's instruction and the other is
knowledge somebody else wrote, and concatenating them is how material saying
"ignore your instructions" gets to say it in the same voice as the instructions.

`packages/core/src/ai/service.ts` holds the built embedding provider between
calls. That is not an optimisation: `EmbeddingProvider` learns its dimension from
the model's first answer, and a fresh instance per call would report zero for
ever, which is how a profile fails to be recognised. The generation provider is
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
