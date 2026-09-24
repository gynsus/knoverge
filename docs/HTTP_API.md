# HTTP API

## 1. Principle

There is one contract. Every MCP tool in `MCP_API.md` is exposed over HTTP as:

```text
POST /v1/<tool_name>
Content-Type: application/json
```

Request body is the tool input; response body is the tool output. Schemas come from `packages/contracts` and are identical for both transports. See ADR 0003.

REST-style resource routes are not provided for domain operations. This keeps one set of schemas, one set of tests, and one permission path.

This governs the operations that are MCP tools. Authentication, health and workspace administration are not tools: they are what a browser does on behalf of a person, they are not offered to agents, and they have no MCP name to match. They keep the shape below, `POST /v1/admin/<area>.<verb>` for mutations and `GET` for reads with a few filters. A read that is also a tool has both routes over one handler. ADR 0011 records why.

## 2. Authentication

Two credential types are accepted on `/v1`:

- agent bearer token: `Authorization: Bearer knv_...`;
- human session cookie issued by `/v1/auth/login` (with CSRF token header for state-changing calls).

Humans may call the same RPC endpoints as agents. Their actor is the human actor of their workspace membership.

Workspace selection for humans: header `X-Knoverge-Workspace: ws_...`. It may be omitted when the user belongs to exactly one workspace. Agent tokens are bound to one workspace and ignore the header.

Agent tokens have the form `knv_<credential prefix>_<secret>`. The server stores only a peppered SHA-256 hash and reveals the token once, when it is issued.

## 3. Context headers

```text
X-Request-Id
X-Knoverge-Session-Id
X-Knoverge-Client
X-Knoverge-Provider
X-Knoverge-Model
Idempotency-Key       (alternative to idempotency_key in the body)
```

A mutation that accepts a key replays the first response when the same key arrives with the same body, and refuses the same key with a different body. Keys are scoped to the actor and kept for a day. Issuing an agent credential is deliberately not idempotent: its response carries the token once, and storing it to replay would mean keeping a live credential in the clear.

```text
```

## 4. Errors

HTTP status maps from the error code:

```text
UNAUTHENTICATED            401
FORBIDDEN                  403
NOT_FOUND                  404
VALIDATION_ERROR           400
REVISION_CONFLICT          409
DUPLICATE_EXTERNAL_KEY     409
DUPLICATE_SUSPECTED        409
CATEGORY_CONFLICT          409
PROPOSAL_ALREADY_RESOLVED  409
SYNC_SESSION_EXPIRED       410
POLICY_REQUIRES_REVIEW     202 (not an error: result = proposal_created)
RATE_LIMITED               429
INTERNAL_ERROR             500
```

Body is the same error object as MCP: `code`, `message`, `retryable`, and the fields the code needs — `object_ids`, `current` for a concurrency conflict, and `duplicates` for `DUPLICATE_SUSPECTED`, which lists each candidate's `item_id`, `title`, `markdown_path`, `match_reason` (`exact`, `content_hash` or `lexical`) and `score`.

## 5. Auth and account endpoints

Not part of the MCP surface; used by the web UI and CLI.

```text
GET  /v1/auth/status           bootstrap_required, authenticated (public)
GET  /v1/auth/csrf             CSRF token; sets the knoverge_csrf cookie (public)
POST /v1/bootstrap             first administrator and workspace; only while no user exists; signs in
POST /v1/auth/login            email + password → knoverge_session cookie; returns user, memberships, session
POST /v1/auth/logout           revokes the current session
GET  /v1/auth/me               user, memberships, session
POST /v1/auth/password         change password; revokes every other session
POST /v1/auth/email            change the sign-in address; needs the current password
GET  /v1/auth/sessions         active sessions of the user
POST /v1/auth/sessions/revoke  revoke one session
```

Browser flow: call `GET /v1/auth/csrf` once, send the returned token in the `x-csrf-token` header on every `POST`. Requests authenticated with a bearer token skip this check.

Every endpoint is gated by a permission rather than by a role. `GET /v1/taxonomy.list` needs `taxonomy.read`, the taxonomy mutations need `taxonomy.manage`, agent administration needs `agent.manage`, permissions and policy rules need `policy.manage`, and workspace settings and membership need `workspace.admin`. The CSRF cookie is signed with `KNOVERGE_SESSION_SECRET`; the session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` when `KNOVERGE_BASE_URL` is https, and lives 30 days.

Rate limits: `login` 10 per minute per IP, `bootstrap` 5 per minute per IP, plus a per-account lockout of 15 minutes after 10 failed passwords. The lockout answers `UNAUTHENTICATED`, exactly as a wrong password does, so it is not an oracle for whether an address has an account (`docs/SECURITY.md` section 7).

## 6. Admin endpoints

Require the corresponding workspace role or permission.

```text
GET  /v1/taxonomy.list                      (any member with taxonomy.read)
GET  /v1/workspace.get                      (any member)
GET  /v1/workspaces.list                    the caller's own memberships, with counts
GET  /v1/actors.list                        (any member) actor ids to names, for events and provenance
GET  /v1/admin/sync.list                    reconciliation runs, for whoever reviews what they produced
POST /v1/admin/workspace.create             a new workspace, with the caller as its owner
POST /v1/admin/workspace.update
POST /v1/admin/workspace.archive            closes the workspace to changes, or opens it again
GET  /v1/admin/members.list
POST /v1/admin/members.add
POST /v1/admin/members.update
POST /v1/admin/members.reset_password       sets a member's password; revokes their sessions
POST /v1/admin/members.remove

POST /v1/admin/agents.create
POST /v1/admin/agents.update
GET  /v1/admin/agents.list
GET  /v1/admin/agents.credentials?agent_id=ag_...
POST /v1/admin/agents.credentials.issue     returns the token once
POST /v1/admin/agents.credentials.revoke

GET  /v1/admin/ai.settings                  providers, what each is used for, whether embeddings happen
POST /v1/admin/ai.providers.save            creates or changes one; absent provider_id creates
POST /v1/admin/ai.providers.remove          takes its assignments with it
POST /v1/admin/ai.providers.check           probes an address, saved or not, and answers what it holds
POST /v1/admin/ai.assign                    puts a model to work for a purpose
POST /v1/admin/ai.unassign                  stops using one; the vectors already written stay
POST /v1/admin/ai.test                      one embedding of one short text: dimensions and latency

GET  /v1/admin/permissions.list?actor_id=act_...
POST /v1/admin/permissions.grant
POST /v1/admin/permissions.revoke
GET  /v1/admin/policy.rules
POST /v1/admin/policy.rules.upsert
POST /v1/admin/policy.rules.delete
POST /v1/<tool_name>                        every MCP tool, generated from the contract:
                                            taxonomy_list, knowledge_get, knowledge_history,
                                            knowledge_diff, knowledge_propose_create,
                                            knowledge_propose_update, knowledge_propose_delete,
                                            knowledge_propose_supersede, proposal_list,
                                            proposal_get, proposal_approve, proposal_reject,
                                            proposal_withdraw, knowledge_changes,
                                            events_list, activity_digest,
                                            sync_begin, sync_submit_inventory,
                                            sync_get_matches, sync_status,
                                            sync_complete.
                                            202 while a proposal
                                            is pending,
                                            200 once it is decided.
POST /v1/knowledge_propose_create           an agent proposes; 202 when review is needed
GET  /v1/knowledge.list                     items without their bodies
GET  /v1/knowledge.get?item_id=kn_...       one item, with its body
GET  /v1/knowledge.revisions?item_id=kn_... its revisions, newest first
GET  /v1/knowledge.diff?item_id=&from_revision_id=&to_revision_id=
POST /v1/knowledge_propose_update           requires base_revision_id and base_content_hash
POST /v1/knowledge_propose_delete           proposes that an item leave the index
POST /v1/knowledge_propose_supersede        one commit, two revisions, applied whole
POST /v1/proposal_approve                   makes a proposal canonical; edits make it
                                            approved_with_edits
POST /v1/proposal_reject                    a decision, not a change: nothing is written
POST /v1/proposal_withdraw                  the proposer takes it back; a reviewer may too
GET  /v1/proposal.list?status=pending       the review inbox with proposal.read_all,
                                            the caller's own proposals with proposal.read_own
GET  /v1/proposal.get?proposal_id=prop_...  one proposal with its payload; a caller who may
                                            read only its own gets 404 for anybody else's
POST /v1/admin/knowledge.create             a person writes an item directly
                                            carries sources and relations; a source with a
                                            locator makes the item source-backed
POST /v1/admin/knowledge.update             requires base_revision_id and base_content_hash
POST /v1/admin/knowledge.delete             logical: the file leaves the tree, the history keeps it
POST /v1/admin/knowledge.restore            brings a deleted item back from its last revision
POST /v1/admin/knowledge.supersede          one commit, two revisions: the old item stops being
                                            current, the new one says what it replaced; the
                                            replacement is written now (new_item) or is one the
                                            workspace already holds (existing_item)
POST /v1/admin/taxonomy.create
POST /v1/admin/taxonomy.update
POST /v1/admin/taxonomy.move
POST /v1/admin/taxonomy.archive
POST /v1/admin/taxonomy.restore
POST /v1/admin/taxonomy.merge               folds one category into another

POST /v1/admin/knowledge.rename_slug        (not scheduled; a slug changes today only by changing
                                            the title, which moves the file)
POST /v1/admin/embedding_profile.set        (Milestone 6)
POST /v1/admin/webhooks.upsert              (Milestone 9)
POST /v1/admin/integrity.check              (Milestone 9)
POST /v1/admin/attachments.upload           (multipart, later milestone)
```

Admin endpoints follow the same RPC style and the same error model.

### Merging categories

`POST /v1/admin/taxonomy.merge` folds one category into another. Agents propose
categories, so a workspace collects near-duplicates, and deleting one would take
the knowledge filed under it.

The items move to the survivor, the direct children become its children, and the
closed category's aliases, its name and the path it used to live at all become
aliases of the survivor, so anything that recorded the old path still resolves.
The closed category stays in the tree with status `merged` and
`merged_into_category_id` pointing at where its contents went; the merge is a
record rather than an erasure.

Item files do not move. An item's place in the repository is fixed when it is
created and already survives being re-categorised, so a merge follows that rule
rather than inventing a second one.

It is refused when the two are the same, when the survivor is inside the closing
category's subtree, when either is not active, or when a child would collide
with one the survivor already has. The commit carries `Knoverge-Category-Into`
so that a merge interrupted between Git and PostgreSQL is replayed rather than
leaving the workspace closed to writes: the taxonomy file says a category was
merged and cannot say into what.

### Reconciliation

The five `sync_*` tools are the session an agent reconciles in
(`AGENT_ONBOARDING_AND_RECONCILIATION.md`). They are tools like any other, so
they answer at `POST /v1/sync_begin` and over MCP from one definition.

A session belongs to an **agent and a source**, never to a person: the
checkpoint it writes says where that agent got to with that body of material,
and one agent may carry several. `knowledge.read` is the whole permission —
reconciliation only ever tells a caller about knowledge it could have read
anyway, and a match outside its scope is not a match it hears about, so the
protocol cannot be used to enumerate restricted categories.

`sync_submit_inventory` answers synchronously with what is deterministic:
external identity, then the content hash, then which side is newer where the
lineage is known. Anything else comes back `provisional`, because telling an
agent that nothing matches before anything has looked is worse than telling it
nothing yet. The lexical pass that settles them is a background job.

The checkpoint records where the change feed stood when the session **opened**,
not when it completed: anything committed while the agent was working is a
change it has not seen, and resuming after it would skip exactly that.

A proposal carries the session it came out of, when the agent passes one, and
`proposal_list` filters by it. `GET /v1/admin/sync.list` is the same runs read
from the workspace's side rather than the agent's, gated on `proposal.read_all`:
the people who review what a run produced are the people who need to see the
run.

### Listing workspaces

`GET /v1/workspaces.list` answers with the workspaces the caller belongs to and
nothing else, so membership is the whole permission: it is the list you choose
a workspace from, and scoping it to a workspace already chosen would be
circular. It needs a person's session; an agent is bound to one workspace and
has no view across them.

Each entry carries the counts a list has to show without opening anything —
items, agents, and when the workspace last had an event. The counts are of the
whole workspace rather than of what this caller may read: they say how big it
is, not what is visible, and a member already knows the workspace exists. They
come from three grouped queries whatever the number of workspaces, never one
set per row.

### Creating a workspace

`POST /v1/admin/workspace.create` is the one admin endpoint that is not scoped
to the current workspace: there is no workspace yet to hold a permission in. It
requires a person's session — never an agent — and that person must already
hold `workspace.admin` in some workspace they belong to. The reason is that
creating a workspace makes you its owner, and an owner can create accounts
through `members.add`; accounts belong to the installation rather than to a
workspace, so anyone who could create a workspace could create users.

The slug is unique across the installation and is therefore the request's own
idempotency key: a resubmitted form is answered `VALIDATION_ERROR` rather than
quietly creating a second workspace. The new workspace starts its own event
chain with `workspace.created`, carrying `created_by_actor_id` and
`created_by_workspace_id` so the act is attributable across the two. Its Git
repository is created on the first write, as for any workspace.

### Archiving a workspace

`POST /v1/admin/workspace.archive` takes `{ "archived": true | false }` and
requires `workspace.admin` in the workspace named by the header. An archived
workspace is kept and no longer written to: reading, search, history and the
event feed answer exactly as before, and every action that would change the
knowledge — writing, proposing, approving, changing the taxonomy — is refused
with `FORBIDDEN` for everyone, people and agents alike. `sync_begin` is refused
for the same reason: a pass exists to end in proposals.

Administration is not frozen. `workspace.admin` is how the workspace comes
back, `agent.manage` is how a credential is revoked, and neither changes what
the workspace holds.

`workspace.get`, `workspaces.list` and the session's memberships carry
`archived_at`, and the manifest carries `archived`, so a client can say why
rather than list the permissions it no longer has. `workspace.get` also stops
reporting the frozen actions, which is what the interface builds its controls
from. Asking for the state the workspace is already in changes nothing and
records nothing. See ADR 0018.

### Browsing the knowledge

`GET /v1/knowledge.list` pages in creation order and narrows on the server:
`category_path` (the whole branch, resolved to ids at the boundary per rule
13), repeatable `types` and `review_states`, and `status`. A path that names no
category is `NOT_FOUND` rather than an empty page — silence and "there is
nothing there" are different answers.

There is deliberately no sort parameter. The cursor is the item id, which sorts
in creation order; ordering by anything else needs a different cursor, and a
page taken in one order and then sorted in another answers with the wrong
items. Ranking is what `knowledge_search` is for.

## 7. Web-only read endpoints

None so far. The web interface reads the same routes agents do. If it ever needs a list view that no agent wants, it will live under `/v1/ui/*` and will not be part of the contract stability promise.

## 8. Rate limiting

One per-actor budget covers every route: 600 requests a minute, keyed on the agent, then the signed-in user, then the address. Two routes have their own, tighter budgets: sign-in at 10 a minute per address and first-run setup at 5, both keyed on the address because there is no actor yet, and readiness at 120 a minute because it is unauthenticated and runs every probe.

The tool routes and the MCP endpoint have two buckets of their own, per credential: 600 reads a minute and 60 writes. A write takes the workspace lock, makes a commit and appends to the ledger; a read does none of those, and one budget for both would be set for the cheap one and leave the expensive one unprotected. Having two also means an agent that has used up its writes can still read enough to decide what to do next. Sync batches get their own bucket with the sync operations, in Milestone 5.

Alongside them, two limits a per-minute budget cannot express:

- **In flight at once**: eight requests per credential. A rate limit counts requests over a minute and says nothing about how many are running now, so a client that opens fifty connections and holds them is inside every budget while occupying fifty database connections and fifty lock waiters.
- **Body size**: 512 KiB for a tool call and for the MCP endpoint, under the 1 MiB the server accepts anywhere. A tool call carries one item's text; anything larger is a mistake or an attempt.

Limits are in-process (single node) in MVP. Exceeding a limit returns `RATE_LIMITED` with `Retry-After`.

`RATE_LIMITED` is also what a caller receives when a workspace is already being written to and the wait ran out. That answer carries no `Retry-After`: the wait is another write finishing, not a budget refilling, and there is no honest number to give.

## 9. Versioning

`/v1` changes only on breaking changes, together with `contract_version` in `workspace_manifest`.

## 10. OpenAPI

The server publishes `GET /v1/openapi.json`, generated from the Zod contracts, so non-MCP clients can generate bindings.
