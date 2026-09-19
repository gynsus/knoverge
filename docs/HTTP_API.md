# HTTP API

## 1. Principle

There is one contract. Every MCP tool in `MCP_API.md` is exposed over HTTP as:

```text
POST /v1/<tool_name>
Content-Type: application/json
```

Request body is the tool input; response body is the tool output. Schemas come from `packages/contracts` and are identical for both transports. See ADR 0003.

REST-style resource routes are not provided for domain operations. This keeps one set of schemas, one set of tests, and one permission path.

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

Body is the same error object as MCP.

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
GET  /v1/auth/sessions         active sessions of the user
POST /v1/auth/sessions/revoke  revoke one session
```

Browser flow: call `GET /v1/auth/csrf` once, send the returned token in the `x-csrf-token` header on every `POST`. The CSRF cookie is signed with `KNOVERGE_SESSION_SECRET`; the session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` when `KNOVERGE_BASE_URL` is https, and lives 30 days.

Rate limits: `login` 10 per minute per IP, `bootstrap` 5 per minute per IP, plus a per-account lockout of 15 minutes after 10 failed passwords (`RATE_LIMITED`).

## 6. Admin endpoints

Require the corresponding workspace role or permission.

```text
POST /v1/admin/agents.create
POST /v1/admin/agents.update
GET  /v1/admin/agents.list
GET  /v1/admin/agents.credentials?agent_id=ag_...
POST /v1/admin/agents.credentials.issue     returns the token once
POST /v1/admin/agents.credentials.revoke

POST /v1/admin/workspaces.create
POST /v1/admin/workspaces.update
POST /v1/admin/members.invite
POST /v1/admin/members.update
POST /v1/admin/members.remove
POST /v1/admin/permissions.grant
POST /v1/admin/permissions.revoke
POST /v1/admin/policy.rules.upsert
POST /v1/admin/policy.rules.delete
POST /v1/admin/taxonomy.create
POST /v1/admin/taxonomy.update
POST /v1/admin/taxonomy.merge
POST /v1/admin/taxonomy.archive
POST /v1/admin/knowledge.restore
POST /v1/admin/knowledge.rename_slug
POST /v1/admin/embedding_profile.set
POST /v1/admin/webhooks.upsert              (Milestone 9)
POST /v1/admin/integrity.check              (Milestone 9)
POST /v1/admin/attachments.upload           (multipart, later milestone)
```

Admin endpoints follow the same RPC style and the same error model.

## 7. Web-only read endpoints

The SPA may need list views that agents do not. They live under `/v1/ui/*`, are documented in code, and are not part of the public contract stability promise.

## 8. Rate limiting

Per-actor limits with separate buckets:

```text
read/search
proposal writes
sync batches
authentication failures (per IP and per email)
```

Limits are in-process (single node) in MVP. Exceeding a limit returns `RATE_LIMITED` with `Retry-After`.

## 9. Versioning

`/v1` changes only on breaking changes, together with `contract_version` in `workspace_manifest`.

## 10. OpenAPI

The server publishes `GET /v1/openapi.json`, generated from the Zod contracts, so non-MCP clients can generate bindings.
