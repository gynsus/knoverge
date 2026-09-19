# ADR 0004: Identity and authentication model

- Status: Accepted
- Date: 2026-09-19

## Context

The initial specification defined agent bearer tokens well but left human authentication undefined and bound human identities to a single workspace. It also listed ChatGPT as a target client without noting that hosted MCP connectors (ChatGPT, Claude.ai) require OAuth 2.1, not static bearer tokens.

Self-hosting constraints matter: email-based login would require SMTP on every installation.

## Decision

### Humans

- Users are instance-level accounts identified by email with an argon2id password hash.
- A user joins a workspace through a `WorkspaceMembership` with a role (`owner`, `admin`, `reviewer`, `viewer`). Each membership has its own human `Actor` for audit.
- Browser sessions are opaque tokens stored hashed, delivered as `HttpOnly` cookies, protected by a CSRF token.
- No SMTP dependency in MVP. TOTP, OIDC sign-in and passkeys are later additions.
- The first administrator is created by `knoverge bootstrap` or a self-disabling bootstrap page.

### Agents

- Agents are workspace-scoped and carry a `trust_tier` (`read_only`, `propose`, `trusted`) that installs default grants. The `propose` tier includes `taxonomy.propose`. The `trusted` tier grants the capability to write directly, but direct writes happen only where an explicit scoped policy rule says `allow_direct`; the default for every agent is `require_review`.
- Permission grants and policy rules store category scopes as stable `category_id` plus `include_descendants`. Paths are accepted at the API boundary and resolved to ids, so renames and merges never change access.
- Policy `deny` creates no proposal; it is recorded as a `command.denied` event.
- Credentials are high-entropy bearer tokens with a `knv_` prefix, stored as peppered SHA-256 hashes, shown once, revocable, optionally expiring.
- One credential belongs to one agent in one workspace.

### Hosted MCP clients

- OAuth 2.1 with PKCE and dynamic client registration is a dedicated later milestone (Milestone 10). Knoverge will be its own authorization server. An OAuth client is bound, through a consent screen, to an agent identity, so the permission and audit model does not change.
- Until then, hosted connectors that require OAuth are not supported; Claude Code, IDE agents, CLI bridges and custom agents use bearer tokens.

## Consequences

### Positive

- Works out of the box without external services.
- One human can manage several workspaces.
- Audit attribution is uniform for humans, agents and OAuth clients.
- Clear path to ChatGPT/Claude.ai connectors without redesign.

### Negative

- Password-only login in MVP; operators exposing the UI publicly are advised to use a private network or reverse-proxy authentication until TOTP ships.
- An OAuth authorization server is real work and adds security surface later.

## Rejected alternatives

### Email one-time codes for MVP

User-friendly but requires SMTP configuration on every self-hosted install. Rejected for MVP.

### Static bearer tokens forever

Excludes hosted connectors. Rejected as the end state, accepted as the MVP state.

### Per-workspace human identities

Simple, but a person with two workspaces would have two logins. Rejected.
