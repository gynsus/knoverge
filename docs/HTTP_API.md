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
POST /v1/admin/workspace.update
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
                                            proposal_withdraw, events_list. 202 while a proposal
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
POST /v1/admin/taxonomy.merge              (arrives with knowledge items, Milestone 2)

POST /v1/admin/knowledge.rename_slug        (Milestone 2)
POST /v1/admin/embedding_profile.set        (Milestone 6)
POST /v1/admin/webhooks.upsert              (Milestone 9)
POST /v1/admin/integrity.check              (Milestone 9)
POST /v1/admin/attachments.upload           (multipart, later milestone)
```

Admin endpoints follow the same RPC style and the same error model.

## 7. Web-only read endpoints

None so far. The web interface reads the same routes agents do. If it ever needs a list view that no agent wants, it will live under `/v1/ui/*` and will not be part of the contract stability promise.

## 8. Rate limiting

One per-actor budget covers every route: 600 requests a minute, keyed on the agent, then the signed-in user, then the address. Two routes have their own, tighter budgets: sign-in at 10 a minute per address and first-run setup at 5, both keyed on the address because there is no actor yet, and readiness at 120 a minute because it is unauthenticated and runs every probe.

Separate buckets for reads, proposal writes and sync batches are not implemented. They arrive with the operations they meter.

Limits are in-process (single node) in MVP. Exceeding a limit returns `RATE_LIMITED` with `Retry-After`.

`RATE_LIMITED` is also what a caller receives when a workspace is already being written to and the wait ran out. That answer carries no `Retry-After`: the wait is another write finishing, not a budget refilling, and there is no honest number to give.

## 9. Versioning

`/v1` changes only on breaking changes, together with `contract_version` in `workspace_manifest`.

## 10. OpenAPI

The server publishes `GET /v1/openapi.json`, generated from the Zod contracts, so non-MCP clients can generate bindings.
